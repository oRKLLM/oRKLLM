<template>
  <!-- Navbar -->
  <v-app-bar flat class="glass-nav px-4" density="comfortable">
    <!-- Hamburger on mobile, chip icon on desktop -->
    <v-icon
      color="primary"
      size="28"
      class="mr-2 d-flex d-sm-none cursor-pointer"
      @click="mobileNavOpen = !mobileNavOpen"
    >mdi-menu</v-icon>
    <v-icon color="primary" size="32" class="mr-2 d-none d-sm-flex">mdi-chip</v-icon>

    <v-app-bar-title>
      <!-- Brand stacked vertically: logo on top, version + status dot on the line below -->
      <div class="brand-row">
        <!-- oRKLLM text always navigates to dashboard -->
        <span
          class="brand-name font-weight-bold text-h5 text-gradient cursor-pointer"
          @click="$router.push('/')"
        >oRKLLM</span>
        <!-- Version + status dot: hidden on mobile (shown in user drawer instead).
             Grouped so they travel together and never wrap. -->
        <span class="brand-meta d-none d-sm-inline-flex">
          <!-- Version links to the exact GitHub release matching this build. -->
          <a
            :href="`https://github.com/oRKLLM/oRKLLM/releases/tag/v${appVersion}`"
            target="_blank"
            rel="noopener noreferrer"
            class="nav-version text-primary text-decoration-none"
            style="font-size: 0.65rem; line-height: 1; opacity: 0.7;"
            :title="`View the v${appVersion} release on GitHub`"
          >v{{ appVersion }}</a>
          <!-- Backend connection indicator — green while the /ws/health socket is open, red on
               close/error. Mirrors the Logs page's connected/disconnected dot (WebSocket, not polling). -->
          <v-icon
            :color="backendConnected ? 'success' : 'error'"
            size="10"
            :title="backendConnected ? 'Backend connected' : 'Backend disconnected'"
          >mdi-circle</v-icon>
        </span>
      </div>
    </v-app-bar-title>

    <!-- Desktop/tablet nav buttons — absolutely centred so left (brand) and right (account) widths don't matter -->
    <div class="nav-center d-none d-sm-flex align-center gap-1">
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
        <span class="d-none d-md-inline">{{ nav.label }}</span>
      </v-btn>
    </div>

    <v-spacer></v-spacer>

    <v-btn icon color="primary" variant="tonal" size="36" @click="drawerOpen = !drawerOpen">
      <v-icon size="20">mdi-account</v-icon>
    </v-btn>
  </v-app-bar>

  <!-- Mobile nav drawer (xs screens) -->
  <v-navigation-drawer
    v-model="mobileNavOpen"
    location="left"
    temporary
    width="200"
    class="d-sm-none"
  >
    <v-list density="compact" class="py-2">
      <v-list-item
        v-for="nav in navItems"
        :key="nav.path"
        :prepend-icon="nav.icon"
        :title="nav.label"
        :to="nav.path"
        :active="isActive(nav.path)"
        active-color="primary"
        rounded="lg"
        class="mx-2 mb-1"
        @click="mobileNavOpen = false"
      ></v-list-item>
    </v-list>
  </v-navigation-drawer>

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
        <div class="text-body-2 font-weight-bold">{{ user.username }}</div>
        <div v-if="user.email" class="text-caption text-grey mt-1">{{ user.email }}</div>
        <div v-if="user.authProvider && user.authProvider !== 'local'" class="mt-2">
          <v-chip
            size="x-small"
            :color="user.authProvider === 'saml' ? 'teal' : 'primary'"
            variant="tonal"
          >
            {{ user.authProvider.toUpperCase() }}
          </v-chip>
        </div>
      </v-list-item>
      <v-divider></v-divider>
      <v-list-item
        v-if="user.role === 'admin'"
        prepend-icon="mdi-shield-account-outline"
        title="Site Management"
        @click="$router.push('/site-management'); drawerOpen = false"
      ></v-list-item>
      <v-divider v-if="user.role === 'admin'"></v-divider>
      <v-list-item
        :prepend-icon="isDark ? 'mdi-weather-sunny' : 'mdi-weather-night'"
        :title="isDark ? 'Light Mode' : 'Dark Mode'"
        @click="$emit('toggle-theme')"
      ></v-list-item>
      <v-divider></v-divider>
      <v-list-item
        prepend-icon="mdi-github"
        title="Contribute"
        href="https://github.com/oRKLLM/oRKLLM"
        target="_blank"
        rel="noopener"
      ></v-list-item>
      <v-divider></v-divider>
      <v-list-item
        prepend-icon="mdi-logout"
        title="Sign Out"
        @click="$emit('logout')"
        class="text-error"
      ></v-list-item>
      <v-divider class="mt-1"></v-divider>
      <div class="px-4 py-2 text-center">
        <span class="text-caption text-grey">v{{ appVersion }}</span>
      </div>
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
    user: {
      type: Object,
      default: () => ({ username: 'admin', role: 'admin', authProvider: 'local' })
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
    mobileNavOpen: false,
    backendConnected: false,
    navItems: [
      { path: '/',         label: 'Dashboard', icon: 'mdi-view-dashboard-outline' },
      { path: '/models',   label: 'Models',    icon: 'mdi-chip' },
      { path: '/settings', label: 'Settings',  icon: 'mdi-cog-outline' },
      { path: '/logs',     label: 'Logs',      icon: 'mdi-text-box-outline' },
      { path: '/bench',    label: 'Bench',     icon: 'mdi-speedometer' },
      { path: '/chat',     label: 'Chat',      icon: 'mdi-chat-outline' },
      { path: '/help',     label: 'Help',      icon: 'mdi-lifebuoy' },
    ]
  }),
  mounted() {
    this.connectHealthWs();
  },
  beforeUnmount() {
    this.disconnectHealthWs();
  },
  methods: {
    isActive(path) {
      if (path === '/') {
        return this.route.path === '/';
      }
      return this.route.path.startsWith(path);
    },
    // Backend connection indicator via WebSocket (replaces a 5s /api/version poll): green while the
    // socket is open, red on close/error. A server heartbeat arms a watchdog so a dropped link that
    // doesn't fire onclose still flips the dot red; the socket auto-reconnects.
    connectHealthWs() {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      try {
        this._healthWs = new WebSocket(`${proto}//${window.location.host}/ws/health`);
      } catch { this.backendConnected = false; return; }
      const up = () => { this.backendConnected = true; this._armHealthWatchdog(); };
      this._healthWs.onopen = up;
      this._healthWs.onmessage = up;   // heartbeat
      this._healthWs.onerror = () => { this.backendConnected = false; };
      this._healthWs.onclose = () => {
        this.backendConnected = false;
        clearTimeout(this._healthWatch);
        this._healthReconnect = setTimeout(() => this.connectHealthWs(), 5000);
      };
    },
    // If no heartbeat arrives within ~2.5 intervals, treat the link as dead.
    _armHealthWatchdog() {
      clearTimeout(this._healthWatch);
      this._healthWatch = setTimeout(() => { this.backendConnected = false; }, 38000);
    },
    disconnectHealthWs() {
      clearTimeout(this._healthWatch);
      clearTimeout(this._healthReconnect);
      if (this._healthWs) { this._healthWs.onclose = null; try { this._healthWs.close(); } catch {} this._healthWs = null; }
    }
  }
};
</script>

<style scoped>
/* True centre regardless of left/right element widths */
.nav-center {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}

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

/* Brand stacked: logo on the first line, version + status dot on the second */
.brand-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  flex-wrap: nowrap;
  white-space: nowrap;
  line-height: 1.1;
}
.brand-name {
  line-height: 1.1;
}
.brand-meta {
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-top: 1px;
}
</style>
