import { createApp } from 'vue';
import App from './App.vue';
import vuetify from './plugins/vuetify';
import router from './router';
import { notify } from './notify.js';

const app = createApp(App);

app.use(vuetify);
app.use(router);

// Global $notify — replaces browser alert() with a Vuetify snackbar
app.config.globalProperties.$notify = notify;

app.mount('#app');
