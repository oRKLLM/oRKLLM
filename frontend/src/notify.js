import { reactive } from 'vue';

export const snackbar = reactive({
  show: false,
  message: '',
  color: 'info',
  timeout: 4000,
  action: null, // optional { label, onClick }
});

// action: optional { label, onClick } — renders an extra button in the snackbar
// (used e.g. by the PWA "new version available → Reload" prompt).
export function notify(message, color = 'info', timeout = 4000, action = null) {
  snackbar.message = message;
  snackbar.color = color;
  snackbar.timeout = timeout;
  snackbar.action = action;
  snackbar.show = true;
}
