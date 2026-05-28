<template>
  <!-- Navbar -->
  <v-app-bar flat class="glass-nav px-4" density="comfortable">
    <v-icon color="primary" class="mr-2" size="32">mdi-chip</v-icon>
    <v-app-bar-title class="d-flex align-center gap-2">
      <span class="font-weight-bold text-h5 text-gradient">oRKLLM</span>
      <v-chip size="x-small" variant="outlined" color="primary" class="font-weight-regular text-caption mt-1">v{{ appVersion }}</v-chip>
    </v-app-bar-title>

    <v-spacer></v-spacer>

    <!-- Center nav buttons -->
    <div class="d-flex align-center gap-1 mx-2">
      <v-btn
        v-for="nav in navItems"
        :key="nav.path"
        :to="nav.path"
        :prepend-icon="nav.icon"
        variant="text"
        size="small"
        :color="isActive(nav.path) ? 'primary' : 'default'"
        :class="['nav-btn', isActive(nav.path) ? 'nav-btn--active' : '']"
      >
        {{ nav.label }}
      </v-btn>
    </div>

    <v-spacer></v-spacer>

    <v-btn icon color="primary" variant="tonal" size="36" @click="drawerOpen = true">
      <v-icon size="20">mdi-account</v-icon>
    </v-btn>
  </v-app-bar>

  <!-- User slide-out drawer -->
  <v-navigation-drawer
    v-model="drawerOpen"
    location="right"
    temporary
    width="240"
  >
    <v-list density="compact" class="py-1">
      <v-list-item class="px-4 py-3">
        <div class="text-caption text-grey">Signed in as</div>
        <div class="text-body-2 font-weight-bold">{{ username }}</div>
      </v-list-item>
      <v-divider></v-divider>
      <v-list-item
        :prepend-icon="isDark ? 'mdi-weather-sunny' : 'mdi-weather-night'"
        :title="isDark ? 'Light Mode' : 'Dark Mode'"
        @click="$emit('toggle-theme')"
      ></v-list-item>
      <v-divider></v-divider>
      <v-list-item
        prepend-icon="mdi-logout"
        title="Sign Out"
        @click="$emit('logout')"
        class="text-error"
      ></v-list-item>
    </v-list>
  </v-navigation-drawer>
</template>

<script>
import { useRoute } from 'vue-router';

export default {
  name: 'AppNav',
  props: {
    appVersion: {
      type: String,
      default: ''
    },
    username: {
      type: String,
      default: 'admin'
    },
    isDark: {
      type: Boolean,
      default: true
    }
  },
  emits: ['toggle-theme', 'logout'],
  setup() {
    const route = useRoute();
    return { route };
  },
  data: () => ({
    drawerOpen: false,
    navItems: [
      { path: '/',         label: 'Dashboard', icon: 'mdi-view-dashboard-outline' },
      { path: '/models',   label: 'Models',    icon: 'mdi-chip' },
      { path: '/settings', label: 'Settings',  icon: 'mdi-cog-outline' },
      { path: '/logs',     label: 'Logs',      icon: 'mdi-text-box-outline' },
      { path: '/bench',    label: 'Bench',     icon: 'mdi-speedometer' },
      { path: '/chat',     label: 'Chat',      icon: 'mdi-chat-outline' },
    ]
  }),
  methods: {
    isActive(path) {
      if (path === '/') {
        return this.route.path === '/';
      }
      return this.route.path.startsWith(path);
    }
  }
};
</script>

<style scoped>
.glass-nav {
  background: rgba(17, 24, 39, 0.8) !important;
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(139, 92, 246, 0.15) !important;
}
.v-theme--customLightTheme .glass-nav {
  background: rgba(255, 255, 255, 0.85) !important;
  border-bottom: 1px solid rgba(124, 58, 237, 0.15) !important;
}

.text-gradient {
  background: linear-gradient(135deg, #7C3AED 0%, #F43F5E 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.nav-btn {
  font-size: 0.78rem;
  letter-spacing: 0.02em;
}

.nav-btn--active {
  background: rgba(124, 58, 237, 0.12) !important;
  border-radius: 6px;
}

.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }
</style>
