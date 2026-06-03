// Vulkan compute harness for polar INT8 KV cache quantisation.
//
// Targets the Mali-G52 (panvk / Mesa) on RK3576 via UMA:
//   - Host-visible + device-local buffers (no staging copy on UMA)
//   - 128-thread workgroups, one per 128-dim vector
//   - Sets PAN_I_WANT_A_BROKEN_VULKAN_DRIVER=1 automatically
//   - Falls back gracefully if no compatible GPU is found
//
// Usage:
//   VkQuantizer& q = VkQuantizer::get();
//   if (q.ok()) q.encodePQ8(fp16_ptr, n_vecs, i8_out, norm_out);
//   else        /* fall back to NEON */
//
// The singleton is initialised on first call to get() and reused for
// the lifetime of the process.  Thread-safe init via std::call_once.

#pragma once
#ifdef HAS_VULKAN

#include <vulkan/vulkan.h>
#include <cstring>
#include <cstdlib>
#include <cmath>
#include <vector>
#include <mutex>
#include <stdexcept>
#include "polar_quant_pq8_spv.h"

// ── helpers ────────────────────────────────────────────────────────────────
#define VK_CHECK(expr) do {                                   \
    VkResult _r = (expr);                                     \
    if (_r != VK_SUCCESS)                                     \
        throw std::runtime_error(std::string(#expr) +        \
            " failed: " + std::to_string((int)_r));           \
} while(0)

// ──────────────────────────────────────────────────────────────────────────
class VkQuantizer {
public:
    static VkQuantizer& get() {
        static VkQuantizer inst;
        static std::once_flag flag;
        std::call_once(flag, [&]{ inst.init(); });
        return inst;
    }

    bool ok() const { return ready_; }

    // Encode n_vecs × 128-dim FP16 vectors → INT8 directions + FP16 norms.
    // fp16_in  : n_vecs × 128 × uint16_t
    // i8_out   : n_vecs × 128 × int8_t
    // norm_out : n_vecs × uint16_t
    bool encodePQ8(const uint16_t* fp16_in,
                   uint32_t        n_vecs,
                   int8_t*         i8_out,
                   uint16_t*       norm_out) {
        if (!ready_) return false;
        try {
            run_compute(fp16_in, n_vecs, i8_out, norm_out);
            return true;
        } catch (...) {
            return false;
        }
    }

    ~VkQuantizer() { cleanup(); }

    // non-copyable
    VkQuantizer(const VkQuantizer&) = delete;
    VkQuantizer& operator=(const VkQuantizer&) = delete;

private:
    VkQuantizer() = default;

    // ── Vulkan objects ──────────────────────────────────────────────────
    VkInstance            instance_       = VK_NULL_HANDLE;
    VkPhysicalDevice      phys_dev_       = VK_NULL_HANDLE;
    VkDevice              device_         = VK_NULL_HANDLE;
    VkQueue               compute_queue_  = VK_NULL_HANDLE;
    uint32_t              queue_family_   = UINT32_MAX;
    VkCommandPool         cmd_pool_       = VK_NULL_HANDLE;
    VkDescriptorSetLayout desc_layout_    = VK_NULL_HANDLE;
    VkPipelineLayout      pipe_layout_    = VK_NULL_HANDLE;
    VkShaderModule        shader_mod_     = VK_NULL_HANDLE;
    VkPipeline            pipeline_       = VK_NULL_HANDLE;
    VkDescriptorPool      desc_pool_      = VK_NULL_HANDLE;
    bool                  ready_          = false;

    // Physical device memory properties for UMA buffer allocation
    VkPhysicalDeviceMemoryProperties mem_props_ = {};

    // ── init ────────────────────────────────────────────────────────────
    void init() {
        // panvk safety gate: opt-in to v7 (Mali-G52 Bifrost) support
        ::setenv("PAN_I_WANT_A_BROKEN_VULKAN_DRIVER", "1", 0);

        try {
            create_instance();
            pick_physical_device();
            create_logical_device();
            create_pipeline();
            create_descriptor_pool();
            ready_ = true;
        } catch (const std::exception& e) {
            // GPU unavailable or panvk not ready — will fall back to NEON
            cleanup();
        }
    }

    // ── instance ────────────────────────────────────────────────────────
    void create_instance() {
        VkApplicationInfo app{};
        app.sType            = VK_STRUCTURE_TYPE_APPLICATION_INFO;
        app.pApplicationName = "orkllm-kvcache-quant";
        app.apiVersion       = VK_API_VERSION_1_0;

        VkInstanceCreateInfo ci{};
        ci.sType            = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
        ci.pApplicationInfo = &app;

        VK_CHECK(vkCreateInstance(&ci, nullptr, &instance_));
    }

    // ── physical device: prefer iGPU (Mali) over software rasteriser ────
    void pick_physical_device() {
        uint32_t n = 0;
        vkEnumeratePhysicalDevices(instance_, &n, nullptr);
        if (n == 0) throw std::runtime_error("no Vulkan physical devices");

        std::vector<VkPhysicalDevice> devs(n);
        vkEnumeratePhysicalDevices(instance_, &n, devs.data());

        for (auto dev : devs) {
            VkPhysicalDeviceProperties props{};
            vkGetPhysicalDeviceProperties(dev, &props);

            // Must be INTEGRATED_GPU (Mali on RK3576) not CPU (llvmpipe)
            if (props.deviceType != VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU)
                continue;

            // Must have a compute queue
            if (find_compute_queue(dev) == UINT32_MAX) continue;

            phys_dev_ = dev;
            vkGetPhysicalDeviceMemoryProperties(dev, &mem_props_);
            queue_family_ = find_compute_queue(dev);
            return;
        }
        throw std::runtime_error("no suitable integrated GPU found");
    }

    uint32_t find_compute_queue(VkPhysicalDevice dev) {
        uint32_t n = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(dev, &n, nullptr);
        std::vector<VkQueueFamilyProperties> qprops(n);
        vkGetPhysicalDeviceQueueFamilyProperties(dev, &n, qprops.data());

        for (uint32_t i = 0; i < n; i++)
            if (qprops[i].queueFlags & VK_QUEUE_COMPUTE_BIT) return i;
        return UINT32_MAX;
    }

    // ── logical device ──────────────────────────────────────────────────
    void create_logical_device() {
        float prio = 1.f;
        VkDeviceQueueCreateInfo qci{};
        qci.sType            = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
        qci.queueFamilyIndex = queue_family_;
        qci.queueCount       = 1;
        qci.pQueuePriorities = &prio;

        // Enable 8-bit and 16-bit storage for INT8/FP16 buffers
        VkPhysicalDevice8BitStorageFeatures f8{};
        f8.sType                             = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_8BIT_STORAGE_FEATURES;
        f8.storageBuffer8BitAccess           = VK_TRUE;
        f8.uniformAndStorageBuffer8BitAccess = VK_TRUE;

        VkPhysicalDevice16BitStorageFeatures f16{};
        f16.sType                             = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_16BIT_STORAGE_FEATURES;
        f16.storageBuffer16BitAccess          = VK_TRUE;
        f16.uniformAndStorageBuffer16BitAccess = VK_TRUE;
        f16.pNext                             = &f8;

        const char* ext8  = VK_KHR_8BIT_STORAGE_EXTENSION_NAME;
        const char* ext16 = VK_KHR_16BIT_STORAGE_EXTENSION_NAME;
        const char* exts[] = { ext8, ext16 };

        VkDeviceCreateInfo dci{};
        dci.sType                   = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
        dci.pNext                   = &f16;
        dci.queueCreateInfoCount    = 1;
        dci.pQueueCreateInfos       = &qci;
        dci.enabledExtensionCount   = 2;
        dci.ppEnabledExtensionNames = exts;

        VK_CHECK(vkCreateDevice(phys_dev_, &dci, nullptr, &device_));
        vkGetDeviceQueue(device_, queue_family_, 0, &compute_queue_);

        VkCommandPoolCreateInfo cpci{};
        cpci.sType            = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
        cpci.queueFamilyIndex = queue_family_;
        cpci.flags            = VK_COMMAND_POOL_CREATE_TRANSIENT_BIT;
        VK_CHECK(vkCreateCommandPool(device_, &cpci, nullptr, &cmd_pool_));
    }

    // ── pipeline ────────────────────────────────────────────────────────
    void create_pipeline() {
        // Load embedded SPIR-V
        VkShaderModuleCreateInfo smci{};
        smci.sType    = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
        smci.codeSize = kPolarPQ8SpvSize;
        smci.pCode    = kPolarPQ8Spv;
        VK_CHECK(vkCreateShaderModule(device_, &smci, nullptr, &shader_mod_));

        // Descriptor set layout: 3 storage buffers (in_fp16, out_i8, out_norm)
        VkDescriptorSetLayoutBinding bindings[3] = {};
        for (int i = 0; i < 3; i++) {
            bindings[i].binding         = i;
            bindings[i].descriptorType  = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
            bindings[i].descriptorCount = 1;
            bindings[i].stageFlags      = VK_SHADER_STAGE_COMPUTE_BIT;
        }
        VkDescriptorSetLayoutCreateInfo dlci{};
        dlci.sType        = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
        dlci.bindingCount = 3;
        dlci.pBindings    = bindings;
        VK_CHECK(vkCreateDescriptorSetLayout(device_, &dlci, nullptr, &desc_layout_));

        VkPipelineLayoutCreateInfo plci{};
        plci.sType          = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
        plci.setLayoutCount = 1;
        plci.pSetLayouts    = &desc_layout_;
        VK_CHECK(vkCreatePipelineLayout(device_, &plci, nullptr, &pipe_layout_));

        VkPipelineShaderStageCreateInfo stage{};
        stage.sType  = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
        stage.stage  = VK_SHADER_STAGE_COMPUTE_BIT;
        stage.module = shader_mod_;
        stage.pName  = "main";

        VkComputePipelineCreateInfo cpci{};
        cpci.sType  = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
        cpci.stage  = stage;
        cpci.layout = pipe_layout_;
        VK_CHECK(vkCreateComputePipelines(device_, VK_NULL_HANDLE, 1, &cpci, nullptr, &pipeline_));
    }

    // Descriptor pool — recreated per-call via reuse strategy
    void create_descriptor_pool() {
        VkDescriptorPoolSize ps{};
        ps.type            = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        ps.descriptorCount = 3;

        VkDescriptorPoolCreateInfo dpci{};
        dpci.sType         = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
        dpci.maxSets       = 1;
        dpci.poolSizeCount = 1;
        dpci.pPoolSizes    = &ps;
        dpci.flags         = VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT;
        VK_CHECK(vkCreateDescriptorPool(device_, &dpci, nullptr, &desc_pool_));
    }

    // ── memory helpers (UMA-aware) ───────────────────────────────────────
    // On UMA (Mali), prefer DEVICE_LOCAL | HOST_VISIBLE | HOST_COHERENT.
    uint32_t find_memory_type(uint32_t type_bits, VkMemoryPropertyFlags required) {
        // First pass: find type with all required flags
        for (uint32_t i = 0; i < mem_props_.memoryTypeCount; i++) {
            if (!(type_bits & (1u << i))) continue;
            auto flags = mem_props_.memoryTypes[i].propertyFlags;
            if ((flags & required) == required) return i;
        }
        throw std::runtime_error("no suitable memory type");
    }

    struct GpuBuf {
        VkBuffer       buf = VK_NULL_HANDLE;
        VkDeviceMemory mem = VK_NULL_HANDLE;
        void*          ptr = nullptr; // persistently mapped
    };

    GpuBuf alloc_buffer(VkDeviceSize size, VkBufferUsageFlags usage,
                         VkMemoryPropertyFlags props) {
        GpuBuf gb;

        VkBufferCreateInfo bci{};
        bci.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
        bci.size  = size;
        bci.usage = usage;
        bci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
        VK_CHECK(vkCreateBuffer(device_, &bci, nullptr, &gb.buf));

        VkMemoryRequirements req{};
        vkGetBufferMemoryRequirements(device_, gb.buf, &req);

        VkMemoryAllocateInfo mai{};
        mai.sType           = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
        mai.allocationSize  = req.size;
        mai.memoryTypeIndex = find_memory_type(req.memoryTypeBits, props);
        VK_CHECK(vkAllocateMemory(device_, &mai, nullptr, &gb.mem));
        VK_CHECK(vkBindBufferMemory(device_, gb.buf, gb.mem, 0));

        if (props & VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT)
            VK_CHECK(vkMapMemory(device_, gb.mem, 0, VK_WHOLE_SIZE, 0, &gb.ptr));

        return gb;
    }

    void free_buffer(GpuBuf& gb) {
        if (gb.ptr)  { vkUnmapMemory(device_, gb.mem); gb.ptr = nullptr; }
        if (gb.buf)  { vkDestroyBuffer(device_, gb.buf, nullptr); gb.buf = VK_NULL_HANDLE; }
        if (gb.mem)  { vkFreeMemory(device_, gb.mem, nullptr);    gb.mem = VK_NULL_HANDLE; }
    }

    // ── compute dispatch ─────────────────────────────────────────────────
    void run_compute(const uint16_t* fp16_in, uint32_t n_vecs,
                     int8_t* i8_out, uint16_t* norm_out) {
        const VkDeviceSize in_bytes   = (VkDeviceSize)n_vecs * 128 * sizeof(uint16_t);
        const VkDeviceSize i8_bytes   = (VkDeviceSize)n_vecs * 128 * sizeof(int8_t);
        const VkDeviceSize norm_bytes = (VkDeviceSize)n_vecs * sizeof(uint16_t);

        // UMA flags: device-local + host-visible + host-coherent
        constexpr VkMemoryPropertyFlags UMA_FLAGS =
            VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT  |
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT  |
            VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
        // Fallback without DEVICE_LOCAL if not available
        constexpr VkMemoryPropertyFlags HOST_FLAGS =
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT  |
            VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;

        auto alloc_uma = [&](VkDeviceSize sz, VkBufferUsageFlags usage) -> GpuBuf {
            try { return alloc_buffer(sz, usage, UMA_FLAGS); }
            catch (...) { return alloc_buffer(sz, usage, HOST_FLAGS); }
        };

        auto buf_in   = alloc_uma(in_bytes,   VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
        auto buf_i8   = alloc_uma(i8_bytes,   VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
        auto buf_norm = alloc_uma(norm_bytes,  VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);

        // Write input directly into mapped GPU memory (UMA — no copy)
        std::memcpy(buf_in.ptr, fp16_in, in_bytes);

        // Allocate and update descriptor set
        VkDescriptorSetAllocateInfo dsai{};
        dsai.sType              = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
        dsai.descriptorPool     = desc_pool_;
        dsai.descriptorSetCount = 1;
        dsai.pSetLayouts        = &desc_layout_;
        VkDescriptorSet ds = VK_NULL_HANDLE;
        VK_CHECK(vkAllocateDescriptorSets(device_, &dsai, &ds));

        VkDescriptorBufferInfo dbi[3] = {
            { buf_in.buf,   0, VK_WHOLE_SIZE },
            { buf_i8.buf,   0, VK_WHOLE_SIZE },
            { buf_norm.buf, 0, VK_WHOLE_SIZE },
        };
        VkWriteDescriptorSet writes[3] = {};
        for (int i = 0; i < 3; i++) {
            writes[i].sType           = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
            writes[i].dstSet          = ds;
            writes[i].dstBinding      = i;
            writes[i].descriptorCount = 1;
            writes[i].descriptorType  = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
            writes[i].pBufferInfo     = &dbi[i];
        }
        vkUpdateDescriptorSets(device_, 3, writes, 0, nullptr);

        // Record and submit command buffer
        VkCommandBufferAllocateInfo cbai{};
        cbai.sType              = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
        cbai.commandPool        = cmd_pool_;
        cbai.level              = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
        cbai.commandBufferCount = 1;
        VkCommandBuffer cb = VK_NULL_HANDLE;
        VK_CHECK(vkAllocateCommandBuffers(device_, &cbai, &cb));

        VkCommandBufferBeginInfo cbbi{};
        cbbi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
        cbbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        VK_CHECK(vkBeginCommandBuffer(cb, &cbbi));
        vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline_);
        vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE,
                                pipe_layout_, 0, 1, &ds, 0, nullptr);
        vkCmdDispatch(cb, n_vecs, 1, 1); // one workgroup per vector
        VK_CHECK(vkEndCommandBuffer(cb));

        VkFenceCreateInfo fci{};
        fci.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
        VkFence fence = VK_NULL_HANDLE;
        VK_CHECK(vkCreateFence(device_, &fci, nullptr, &fence));

        VkSubmitInfo si{};
        si.sType              = VK_STRUCTURE_TYPE_SUBMIT_INFO;
        si.commandBufferCount = 1;
        si.pCommandBuffers    = &cb;
        VK_CHECK(vkQueueSubmit(compute_queue_, 1, &si, fence));
        VK_CHECK(vkWaitForFences(device_, 1, &fence, VK_TRUE, UINT64_MAX));

        // Read results from mapped memory (UMA — no copy needed)
        std::memcpy(i8_out,   buf_i8.ptr,   i8_bytes);
        std::memcpy(norm_out, buf_norm.ptr,  norm_bytes);

        // Cleanup per-call resources
        vkDestroyFence(device_, fence, nullptr);
        vkFreeCommandBuffers(device_, cmd_pool_, 1, &cb);
        vkFreeDescriptorSets(device_, desc_pool_, 1, &ds);
        free_buffer(buf_in);
        free_buffer(buf_i8);
        free_buffer(buf_norm);
    }

    // ── cleanup ──────────────────────────────────────────────────────────
    void cleanup() {
        if (device_) {
            vkDeviceWaitIdle(device_);
            if (desc_pool_)   vkDestroyDescriptorPool(device_, desc_pool_, nullptr);
            if (pipeline_)    vkDestroyPipeline(device_, pipeline_, nullptr);
            if (pipe_layout_) vkDestroyPipelineLayout(device_, pipe_layout_, nullptr);
            if (desc_layout_) vkDestroyDescriptorSetLayout(device_, desc_layout_, nullptr);
            if (shader_mod_)  vkDestroyShaderModule(device_, shader_mod_, nullptr);
            if (cmd_pool_)    vkDestroyCommandPool(device_, cmd_pool_, nullptr);
            vkDestroyDevice(device_, nullptr);
        }
        if (instance_) vkDestroyInstance(instance_, nullptr);
        device_ = VK_NULL_HANDLE; instance_ = VK_NULL_HANDLE; ready_ = false;
    }
};

#endif // HAS_VULKAN
