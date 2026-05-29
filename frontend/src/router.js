import { createRouter, createWebHistory } from 'vue-router';
import Dashboard from './views/Dashboard.vue';
import Login from './views/Login.vue';
import Setup from './views/Setup.vue';
import Settings from './views/Settings.vue';
import Models from './views/Models.vue';
import Logs from './views/Logs.vue';
import Bench from './views/Bench.vue';
import Chat from './views/Chat.vue';
import SiteManagement from './views/SiteManagement.vue';

const routes = [
  {
    path: '/',
    name: 'Dashboard',
    component: Dashboard,
  },
  {
    path: '/login',
    name: 'Login',
    component: Login,
  },
  {
    path: '/setup',
    name: 'Setup',
    component: Setup,
  },
  {
    path: '/settings',
    name: 'Settings',
    component: Settings,
  },
  {
    path: '/models',
    name: 'Models',
    component: Models,
  },
  {
    path: '/logs',
    name: 'Logs',
    component: Logs,
  },
  {
    path: '/bench',
    name: 'Bench',
    component: Bench,
  },
  {
    path: '/chat',
    name: 'Chat',
    component: Chat,
  },
  {
    path: '/site-management',
    name: 'SiteManagement',
    component: SiteManagement,
    meta: { requireRole: 'admin' },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to, from, next) => {
  try {
    const res = await fetch('/api/admin/auth-status');
    const auth = await res.json();

    if (auth.status === 'need_setup') {
      if (to.name !== 'Setup') {
        next({ name: 'Setup' });
      } else {
        next();
      }
    } else if (auth.status === 'need_login') {
      if (to.name !== 'Login') {
        next({ name: 'Login' });
      } else {
        next();
      }
    } else {
      if (to.name === 'Login' || to.name === 'Setup') {
        next({ name: 'Dashboard' });
      } else if (to.meta.requireRole) {
        // Role-based access check
        if (auth.user?.role !== to.meta.requireRole && auth.user?.role !== 'admin') {
          next({ name: 'Dashboard' });
        } else {
          next();
        }
      } else {
        next();
      }
    }
  } catch (e) {
    // Fallback if backend is loading or unreachable
    next();
  }
});

export default router;
