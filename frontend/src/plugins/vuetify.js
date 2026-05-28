import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';

const customDarkTheme = {
  dark: true,
  colors: {
    background: '#0B0F19',
    surface: '#111827',
    'surface-variant': '#1F2937',
    primary: '#7C3AED',
    secondary: '#10B981',
    accent: '#F43F5E',
    error: '#EF4444',
    info: '#3B82F6',
    success: '#10B981',
    warning: '#F59E0B',
  },
};

const customLightTheme = {
  dark: false,
  colors: {
    background: '#F1F5F9',
    surface: '#FFFFFF',
    'surface-variant': '#E2E8F0',
    primary: '#7C3AED',
    secondary: '#059669',
    accent: '#E11D48',
    error: '#DC2626',
    info: '#2563EB',
    success: '#059669',
    warning: '#D97706',
  },
};

export default createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: localStorage.getItem('orkllm-theme') || 'customDarkTheme',
    themes: {
      customDarkTheme,
      customLightTheme,
    },
  },
});
