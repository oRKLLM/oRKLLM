import { reactive } from 'vue';

export const snackbar = reactive({
  show: false,
  message: '',
  color: 'info',
  timeout: 4000,
});

export function notify(message, color = 'info', timeout = 4000) {
  snackbar.message = message;
  snackbar.color = color;
  snackbar.timeout = timeout;
  snackbar.show = true;
}
