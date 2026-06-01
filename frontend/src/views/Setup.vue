<template>
  <v-main class="bg-slate-page fill-height">
    <v-container class="fill-height justify-center" fluid>
      <v-card class="mx-auto pa-8 glass-card" max-width="450" elevation="12">
        <div class="text-center mb-6">
          <v-icon color="primary" size="64" class="mb-2">mdi-shield-account-outline</v-icon>
          <h1 class="text-h4 font-weight-bold text-gradient">oRKLLM Setup</h1>
          <p class="text-subtitle-1 text-grey-darken-1">Create your administrator account</p>
        </div>

        <v-form ref="form" v-model="valid" @submit.prevent="submitSetup">
          <v-text-field
            v-model="username"
            label="Username"
            prepend-inner-icon="mdi-account"
            required
            variant="outlined"
            color="primary"
            :rules="[v => !!v || 'Username is required']"
          ></v-text-field>

          <v-text-field
            v-model="password"
            label="Password"
            prepend-inner-icon="mdi-lock"
            type="password"
            required
            variant="outlined"
            color="primary"
            :rules="[
              v => !!v || 'Password is required',
              v => v.length >= 6 || 'Password must be at least 6 characters'
            ]"
          ></v-text-field>

          <v-text-field
            v-model="confirmPassword"
            label="Confirm Password"
            prepend-inner-icon="mdi-lock-check"
            type="password"
            required
            variant="outlined"
            color="primary"
            :rules="[
              v => !!v || 'Please confirm your password',
              v => v === password || 'Passwords do not match'
            ]"
          ></v-text-field>

          <v-checkbox
            v-model="autoDownloadRuntimes"
            color="primary"
            density="compact"
            class="mb-2"
          >
            <template #label>
              <span class="text-body-2">
                Auto-download rkllm runtime versions
                <span class="text-grey text-caption d-block">
                  Downloads pre-built <code>librkllmrt.so</code> files from
                  <a href="https://github.com/mafischer/rkllm-runtimes" target="_blank" class="text-primary">mafischer/rkllm-runtimes</a>
                  for automatic model compatibility matching. Binaries are Apache 2.0 licensed.
                </span>
              </span>
            </template>
          </v-checkbox>

          <v-alert
            v-if="errorMessage"
            type="error"
            variant="tonal"
            class="mb-4"
            closable
            @click:close="errorMessage = ''"
          >
            {{ errorMessage }}
          </v-alert>

          <v-btn
            type="submit"
            color="primary"
            block
            size="large"
            class="mt-4 font-weight-bold"
            :loading="loading"
            :disabled="!valid"
          >
            Initialize Server
          </v-btn>
        </v-form>
      </v-card>
    </v-container>
  </v-main>
</template>

<script>
export default {
  name: 'Setup',
  data: () => ({
    valid: false,
    username: 'admin',
    password: '',
    confirmPassword: '',
    loading: false,
    errorMessage: '',
    autoDownloadRuntimes: true,
  }),
  methods: {
    async submitSetup() {
      if (!this.valid) return;
      this.loading = true;
      this.errorMessage = '';

      try {
        const res = await fetch('/api/admin/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: this.username,
            password: this.password,
            autoDownloadRuntimes: this.autoDownloadRuntimes,
          }),
        });

        const data = await res.json();
        if (res.ok) {
          this.$router.push('/');
        } else {
          this.errorMessage = data.error || 'Failed to complete setup';
        }
      } catch (e) {
        this.errorMessage = 'Network connection error';
      } finally {
        this.loading = false;
      }
    },
  },
};
</script>

<style scoped>
.glass-card {
  background: rgba(17, 24, 39, 0.7) !important;
  backdrop-filter: blur(16px);
  border: 1px solid rgba(139, 92, 246, 0.2);
  border-radius: 16px !important;
}

.text-gradient {
  background: linear-gradient(135deg, #7C3AED 0%, #F43F5E 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
</style>
