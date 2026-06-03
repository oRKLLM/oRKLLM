// Vulkan compute harness for KV cache quantisation (three schemes).
//
// Targets the Mali-G52 (panvk / Mesa) on RK3576 via UMA:
//   - Host-visible + device-local buffers (no staging copy on UMA)
//   - 128-thread workgroups, one per 128-dim vector
//   - Sets PAN_I_WANT_A_BROKEN_VULKAN_DRIVER=1 automatically
//   - Falls back gracefully if no compatible GPU is found
//
// Schemes:
//   pq8 — polar INT8:    L2 norm + direction×INT8  (polar_quant_pq8.comp)
//   q8  — min-max INT8:  max-abs scale + INT8      (minmax_q8.comp)
//   pq4 — polar INT4:    L2 norm + direction×INT4  (polar_pq4.comp)
//
// Usage:
//   VkQuantizer& q = VkQuantizer::get();
//   if (q.ok()) q.encodePQ8(fp16_ptr, n_vecs, i8_out, norm_out);
//   else        /* fall back to NEON */

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
#include "minmax_q8_spv.h"
#include "polar_pq4_spv.h"

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

    // polar INT8: FP16→ INT8 directions + FP16 norm
    bool encodePQ8(const uint16_t* fp16_in, uint32_t n_vecs,
                   int8_t* i8_out, uint16_t* norm_out) {
        if (!ready_) return false;
        try { run_pq8(fp16_in, n_vecs, i8_out, norm_out); return true; }
        catch (...) { return false; }
    }

    // min-max INT8: FP16 → INT8 values + FP32 scale
    bool encodeQ8(const uint16_t* fp16_in, uint32_t n_vecs,
                  int8_t* i8_out, float* scale_out) {
        if (!ready_) return false;
        try { run_q8(fp16_in, n_vecs, i8_out, scale_out); return true; }
        catch (...) { return false; }
    }

    // polar INT4: FP16 → packed nibbles + FP16 norm
    bool encodePQ4(const uint16_t* fp16_in, uint32_t n_vecs,
                   uint8_t* packed_out, uint16_t* norm_out) {
        if (!ready_) return false;
        try { run_pq4(fp16_in, n_vecs, packed_out, norm_out); return true; }
        catch (...) { return false; }
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
    // Shared: one descriptor set layout + pipeline layout (3 storage buffer bindings)
    VkDescriptorSetLayout desc_layout_    = VK_NULL_HANDLE;
    VkPipelineLayout      pipe_layout_    = VK_NULL_HANDLE;
    // Per-scheme shader modules and pipelines
    VkShaderModule        shader_pq8_     = VK_NULL_HANDLE;
    VkShaderModule        shader_q8_      = VK_NULL_HANDLE;
    VkShaderModule        shader_pq4_     = VK_NULL_HANDLE;
    VkPipeline            pipeline_pq8_   = VK_NULL_HANDLE;
    VkPipeline            pipeline_q8_    = VK_NULL_HANDLE;
    VkPipeline            pipeline_pq4_   = VK_NULL_HANDLE;
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
            create_pipelines();
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
    VkShaderModule make_shader(const uint32_t* spv, size_t spv_size) {
        VkShaderModuleCreateInfo ci{};
        ci.sType    = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
        ci.codeSize = spv_size;
        ci.pCode    = spv;
        VkShaderModule m = VK_NULL_HANDLE;
        VK_CHECK(vkCreateShaderModule(device_, &ci, nullptr, &m));
        return m;
    }

    VkPipeline make_pipeline(VkShaderModule shader) {
        VkPipelineShaderStageCreateInfo stage{};
        stage.sType  = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
        stage.stage  = VK_SHADER_STAGE_COMPUTE_BIT;
        stage.module = shader;
        stage.pName  = "main";

        VkComputePipelineCreateInfo cpci{};
        cpci.sType  = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
        cpci.stage  = stage;
        cpci.layout = pipe_layout_;

        VkPipeline p = VK_NULL_HANDLE;
        VK_CHECK(vkCreateComputePipelines(device_, VK_NULL_HANDLE, 1, &cpci, nullptr, &p));
        return p;
    }

    void create_pipelines() {
        // Shared descriptor set layout: 3 storage buffers (same for all schemes)
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

        shader_pq8_   = make_shader(kPolarPQ8Spv,  kPolarPQ8SpvSize);
        shader_q8_    = make_shader(kMinmaxQ8Spv,   kMinmaxQ8SpvSize);
        shader_pq4_   = make_shader(kPolarPq4Spv,   kPolarPq4SpvSize);
        pipeline_pq8_ = make_pipeline(shader_pq8_);
        pipeline_q8_  = make_pipeline(shader_q8_);
        pipeline_pq4_ = make_pipeline(shader_pq4_);
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
    // Generic helper: bind three buffers, dispatch pipeline, readback.
    void dispatch(VkPipeline pipeline, uint32_t n_vecs,
                  GpuBuf& b0, GpuBuf& b1, GpuBuf& b2) {
        VkDescriptorSetAllocateInfo dsai{};
        dsai.sType              = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
        dsai.descriptorPool     = desc_pool_;
        dsai.descriptorSetCount = 1;
        dsai.pSetLayouts        = &desc_layout_;
        VkDescriptorSet ds = VK_NULL_HANDLE;
        VK_CHECK(vkAllocateDescriptorSets(device_, &dsai, &ds));

        VkDescriptorBufferInfo dbi[3] = {
            { b0.buf, 0, VK_WHOLE_SIZE },
            { b1.buf, 0, VK_WHOLE_SIZE },
            { b2.buf, 0, VK_WHOLE_SIZE },
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
        vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
        vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE,
                                pipe_layout_, 0, 1, &ds, 0, nullptr);
        vkCmdDispatch(cb, n_vecs, 1, 1);
        VK_CHECK(vkEndCommandBuffer(cb));

        VkFenceCreateInfo fci{};
        fci.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
        VkFence fence = VK_NULL_HANDLE;
        VK_CHECK(vkCreateFence(device_, &fci, nullptr, &fence));

        VkSubmitInfo si{};
        si.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
        si.commandBufferCount = 1;
        si.pCommandBuffers    = &cb;
        VK_CHECK(vkQueueSubmit(compute_queue_, 1, &si, fence));
        VK_CHECK(vkWaitForFences(device_, 1, &fence, VK_TRUE, UINT64_MAX));

        vkDestroyFence(device_, fence, nullptr);
        vkFreeCommandBuffers(device_, cmd_pool_, 1, &cb);
        vkFreeDescriptorSets(device_, desc_pool_, 1, &ds);
    }

    GpuBuf uma_buf(VkDeviceSize sz) {
        constexpr VkMemoryPropertyFlags UMA =
            VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT |
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
            VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
        constexpr VkMemoryPropertyFlags HOST =
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
            VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
        try { return alloc_buffer(sz, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, UMA); }
        catch (...) { return alloc_buffer(sz, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, HOST); }
    }

    // polar INT8
    void run_pq8(const uint16_t* fp16_in, uint32_t n_vecs,
                 int8_t* i8_out, uint16_t* norm_out) {
        auto bi   = uma_buf((VkDeviceSize)n_vecs * 128 * 2);
        auto bo   = uma_buf((VkDeviceSize)n_vecs * 128 * 1);
        auto bn   = uma_buf((VkDeviceSize)n_vecs * 2);
        std::memcpy(bi.ptr, fp16_in, n_vecs * 128 * 2);
        dispatch(pipeline_pq8_, n_vecs, bi, bo, bn);
        std::memcpy(i8_out,   bo.ptr, n_vecs * 128);
        std::memcpy(norm_out, bn.ptr, n_vecs * 2);
        free_buffer(bi); free_buffer(bo); free_buffer(bn);
    }

    // min-max INT8
    void run_q8(const uint16_t* fp16_in, uint32_t n_vecs,
                int8_t* i8_out, float* scale_out) {
        auto bi   = uma_buf((VkDeviceSize)n_vecs * 128 * 2);
        auto bo   = uma_buf((VkDeviceSize)n_vecs * 128 * 1);
        auto bs   = uma_buf((VkDeviceSize)n_vecs * 4);       // FP32 scales
        std::memcpy(bi.ptr, fp16_in, n_vecs * 128 * 2);
        dispatch(pipeline_q8_, n_vecs, bi, bo, bs);
        std::memcpy(i8_out,    bo.ptr, n_vecs * 128);
        std::memcpy(scale_out, bs.ptr, n_vecs * 4);
        free_buffer(bi); free_buffer(bo); free_buffer(bs);
    }

    // polar INT4
    void run_pq4(const uint16_t* fp16_in, uint32_t n_vecs,
                 uint8_t* packed_out, uint16_t* norm_out) {
        auto bi   = uma_buf((VkDeviceSize)n_vecs * 128 * 2);
        auto bp   = uma_buf((VkDeviceSize)n_vecs * 64);      // packed nibbles
        auto bn   = uma_buf((VkDeviceSize)n_vecs * 2);
        std::memcpy(bi.ptr, fp16_in, n_vecs * 128 * 2);
        dispatch(pipeline_pq4_, n_vecs, bi, bp, bn);
        std::memcpy(packed_out, bp.ptr, n_vecs * 64);
        std::memcpy(norm_out,   bn.ptr, n_vecs * 2);
        free_buffer(bi); free_buffer(bp); free_buffer(bn);
    }

    // ── cleanup ──────────────────────────────────────────────────────────
    void cleanup() {
        if (device_) {
            vkDeviceWaitIdle(device_);
            if (desc_pool_)    vkDestroyDescriptorPool(device_, desc_pool_, nullptr);
            if (pipeline_pq8_) vkDestroyPipeline(device_, pipeline_pq8_, nullptr);
            if (pipeline_q8_)  vkDestroyPipeline(device_, pipeline_q8_,  nullptr);
            if (pipeline_pq4_) vkDestroyPipeline(device_, pipeline_pq4_, nullptr);
            if (pipe_layout_)  vkDestroyPipelineLayout(device_, pipe_layout_, nullptr);
            if (desc_layout_)  vkDestroyDescriptorSetLayout(device_, desc_layout_, nullptr);
            if (shader_pq8_)   vkDestroyShaderModule(device_, shader_pq8_, nullptr);
            if (shader_q8_)    vkDestroyShaderModule(device_, shader_q8_,  nullptr);
            if (shader_pq4_)   vkDestroyShaderModule(device_, shader_pq4_, nullptr);
            if (cmd_pool_)     vkDestroyCommandPool(device_, cmd_pool_, nullptr);
            vkDestroyDevice(device_, nullptr);
        }
        if (instance_) vkDestroyInstance(instance_, nullptr);
        device_ = VK_NULL_HANDLE; instance_ = VK_NULL_HANDLE; ready_ = false;
    }
};

#endif // HAS_VULKAN
