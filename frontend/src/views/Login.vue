<template>
  <v-main class="bg-slate-page fill-height">
    <v-container class="fill-height justify-center" fluid>
      <v-card class="mx-auto pa-8 glass-card" max-width="450" elevation="12">
        <div class="text-center mb-6">
          <v-icon color="primary" size="64" class="mb-2">mdi-lock-open-outline</v-icon>
          <h1 class="text-h4 font-weight-bold text-gradient">oRKLLM Login</h1>
          <p class="text-subtitle-1 text-grey-darken-1">Access your administration console</p>
        </div>

        <!-- Federated sign-in button -->
        <template v-if="providerName">
          <v-btn
            color="primary"
            variant="flat"
            block
            size="large"
            prepend-icon="mdi-login-variant"
            class="mb-4 font-weight-bold"
            @click="signInWithProvider"
          >
            Sign in with {{ providerName }}
          </v-btn>

          <div v-if="!localAuthDisabled" class="d-flex align-center mb-4">
            <v-divider></v-divider>
            <span class="text-caption text-grey mx-3">or</span>
            <v-divider></v-divider>
          </div>
        </template>

        <!-- Local login form -->
        <v-form v-if="!localAuthDisabled" ref="form" v-model="valid" @submit.prevent="submitLogin">
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
            :rules="[v => !!v || 'Password is required']"
          ></v-text-field>

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
            Sign In
          </v-btn>
        </v-form>
      </v-card>
    </v-container>
  </v-main>
</template>

<script>
export default {
  name: 'Login',
  data: () => ({
    valid: false,
    username: '',
    password: '',
    loading: false,
    errorMessage: '',
    providerName: null,
    localAuthDisabled: false,
    oidcEnabled: false,
    samlEnabled: false,
  }),
  async mounted() {
    try {
      const res = await fetch('/api/admin/auth-status');
      const data = await res.json();
      this.oidcEnabled = data.oidcEnabled || false;
      this.samlEnabled = data.samlEnabled || false;
      this.providerName = data.providerName || null;
      this.localAuthDisabled = data.localAuthDisabled || false;
    } catch (e) {}
  },
  methods: {
    signInWithProvider() {
      if (this.oidcEnabled) {
        window.location.href = '/api/admin/oidc/authorize';
      } else if (this.samlEnabled) {
        window.location.href = '/api/admin/saml/login';
      }
    },
    async submitLogin() {
      if (!this.valid) return;
      this.loading = true;
      this.errorMessage = '';

      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: this.username,
            password: this.password,
          }),
        });

        const data = await res.json();
        if (res.ok) {
          this.$router.push('/');
        } else {
          this.errorMessage = data.error || 'Invalid credentials';
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
.bg-slate-page {
  background-color: #0B0F19 !important;
}
.v-theme--customLightTheme .bg-slate-page {
  background: #F1F5F9 !important;
}

.glass-card {
  background: rgba(17, 24, 39, 0.7) !important;
  backdrop-filter: blur(16px);
  border: 1px solid rgba(139, 92, 246, 0.2);
  border-radius: 16px !important;
}
.v-theme--customLightTheme .glass-card {
  background: rgba(255, 255, 255, 0.85) !important;
  border: 1px solid rgba(124, 58, 237, 0.2) !important;
}

.text-gradient {
  background: linear-gradient(135deg, #7C3AED 0%, #F43F5E 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
</style>
