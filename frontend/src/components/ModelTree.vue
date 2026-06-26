<template>
  <div class="model-tree">
    <template v-for="node in nodes" :key="node.key">
      <!-- Folder node: collapsible header + recursive children (and its own leaf, if any) -->
      <div v-if="node.isFolder" class="model-tree-folder">
        <div
          class="model-tree-folder-header d-flex align-center px-4 py-2 border-bottom"
          :style="{ paddingLeft: indentPx }"
          role="button"
          tabindex="0"
          @click="toggle(node.key)"
          @keydown.enter.prevent="toggle(node.key)"
          @keydown.space.prevent="toggle(node.key)"
        >
          <v-icon
            size="18"
            class="mr-1 model-tree-chevron"
            :class="{ 'model-tree-chevron--open': isOpen(node.key) }"
          >mdi-chevron-right</v-icon>
          <v-icon size="18" color="grey-darken-1" class="mr-2">
            {{ isOpen(node.key) ? 'mdi-folder-open-outline' : 'mdi-folder-outline' }}
          </v-icon>
          <span class="font-weight-medium text-body-2 text-truncate">{{ node.name }}</span>
          <span class="text-caption text-grey ml-2">{{ node.leafCount }}</span>
        </div>

        <v-expand-transition>
          <div v-show="isOpen(node.key)">
            <!-- A node can be both a folder and a leaf (e.g. owner/repo that is itself an item). -->
            <div
              v-if="node.item"
              class="model-tree-leaf border-bottom"
              :style="{ paddingLeft: childIndentPx }"
            >
              <slot name="leaf" :item="node.item" />
            </div>
            <ModelTree
              :ref="el => registerChild(node.key, el)"
              :items="node.children"
              :path-field="pathField"
              :depth="depth + 1"
              :prefix="node.key"
            >
              <template #leaf="s"><slot name="leaf" v-bind="s" /></template>
            </ModelTree>
          </div>
        </v-expand-transition>
      </div>

      <!-- Pure leaf node -->
      <div
        v-else
        class="model-tree-leaf border-bottom"
        :style="{ paddingLeft: indentPx }"
      >
        <slot name="leaf" :item="node.item" />
      </div>
    </template>
  </div>
</template>

<script>
export default {
  name: 'ModelTree',
  props: {
    // Flat list of items; each is split on '/' (pathField) into a nested tree.
    items: { type: Array, default: () => [] },
    // Which field on each item holds the slash-delimited path.
    pathField: { type: String, required: true },
    // Recursion depth (internal) — drives indentation.
    depth: { type: Number, default: 0 },
    // Path prefix already consumed by ancestors (internal) — makes node keys unique.
    prefix: { type: String, default: '' },
  },
  data() {
    return {
      // Per-session expand/collapse state keyed by node key. Default: expanded.
      collapsed: {},
      // Child ModelTree instances keyed by node key (for recursive expand/collapse-all).
      childTrees: {},
    };
  },
  computed: {
    indentPx() {
      return 16 + this.depth * 16 + 'px';
    },
    childIndentPx() {
      return 16 + (this.depth + 1) * 16 + 'px';
    },
    // Group items by their next path segment (relative to the consumed prefix).
    nodes() {
      const groups = new Map();
      for (const item of this.items) {
        const full = String(item[this.pathField] ?? '');
        const segs = full.split('/').filter(Boolean);
        const rel = this.prefix ? segs.slice(this.prefix.split('/').filter(Boolean).length) : segs;
        const seg = rel[0] ?? full;
        const key = this.prefix ? `${this.prefix}/${seg}` : seg;
        if (!groups.has(key)) {
          groups.set(key, { key, name: seg, items: [], directItem: null });
        }
        const g = groups.get(key);
        g.items.push(item);
        // rel.length <= 1 → this item terminates at this node (it's a leaf here).
        if (rel.length <= 1) g.directItem = item;
      }

      const out = [];
      for (const g of groups.values()) {
        // Children = items that have further path segments beyond this node.
        const children = g.items.filter(it => it !== g.directItem);
        const isFolder = children.length > 0;
        if (isFolder) {
          out.push({
            key: g.key,
            name: g.name,
            isFolder: true,
            children,
            item: g.directItem,          // may be null; node can be folder + leaf
            leafCount: g.items.length,
          });
        } else {
          out.push({
            key: g.key,
            name: g.name,
            isFolder: false,
            item: g.directItem ?? g.items[0],
          });
        }
      }
      return out;
    },
    // Keys of folder nodes at this level (those with collapsible children).
    folderKeys() {
      return this.nodes.filter(n => n.isFolder).map(n => n.key);
    },
  },
  methods: {
    isOpen(key) {
      // Expanded by default; collapsed only if explicitly toggled shut.
      return !this.collapsed[key];
    },
    toggle(key) {
      this.collapsed = { ...this.collapsed, [key]: !this.collapsed[key] };
    },
    // Track child ModelTree instances so expand/collapse-all can recurse into them.
    registerChild(key, el) {
      if (el) this.childTrees[key] = el;
      else delete this.childTrees[key];
    },
    // Does this subtree contain any collapsible folder at any depth?
    hasFolders() {
      return this.folderKeys.length > 0;
    },
    // Open every folder node in this subtree (recursing into children).
    expandAll() {
      this.collapsed = {};
      this.$nextTick(() => {
        for (const child of Object.values(this.childTrees)) child?.expandAll?.();
      });
    },
    // Collapse every folder node in this subtree.
    collapseAll() {
      // Recurse first (while children are still mounted), then collapse this level.
      for (const child of Object.values(this.childTrees)) child?.collapseAll?.();
      const next = {};
      for (const key of this.folderKeys) next[key] = true;
      this.collapsed = next;
    },
  },
};
</script>

<style scoped>
.model-tree-folder-header {
  cursor: pointer;
  user-select: none;
}
.model-tree-folder-header:hover {
  background: rgba(127, 127, 127, 0.06);
}
.model-tree-chevron {
  transition: transform 0.18s ease;
}
.model-tree-chevron--open {
  transform: rotate(90deg);
}
</style>
