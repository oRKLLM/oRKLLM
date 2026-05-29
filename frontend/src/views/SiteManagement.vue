<template>
  <AppNav
    :app-version="appVersion"
    :user="currentUser"
    :is-dark="isDark"
    @toggle-theme="toggleTheme"
    @logout="logout"
  />

  <v-main class="bg-slate-page fill-height">
    <v-container fluid class="pt-6 px-6" style="max-width: 1100px;">

      <!-- Snackbar -->
      <v-snackbar v-model="snackbar.show" :color="snackbar.color" location="bottom right" :timeout="3000">
        {{ snackbar.text }}
      </v-snackbar>

      <div class="text-h5 font-weight-bold mb-1">Site Management</div>
      <div class="text-caption text-grey mb-6">Manage users, authentication providers, and audit logs.</div>

      <v-tabs v-model="tab" color="primary" class="mb-6">
        <v-tab value="users">
          <v-icon start>mdi-account-group-outline</v-icon>
          Users
        </v-tab>
        <v-tab value="auth-providers">
          <v-icon start>mdi-shield-key-outline</v-icon>
          Auth Providers
        </v-tab>
        <v-tab value="audit-log">
          <v-icon start>mdi-clipboard-text-clock-outline</v-icon>
          Audit Log
        </v-tab>
      </v-tabs>

      <v-tabs-window v-model="tab">

        <!-- ===== USERS TAB ===== -->
        <v-tabs-window-item value="users">

          <!-- Status card -->
          <v-card class="glass-card pa-4 mb-5">
            <div class="d-flex align-center justify-space-between flex-wrap gap-3">
              <div class="d-flex align-center gap-3">
                <v-icon color="primary" size="28">mdi-account-group-outline</v-icon>
                <div>
                  <div class="text-body-1 font-weight-bold">{{ users.length }} User{{ users.length !== 1 ? 's' : '' }}</div>
                  <div class="text-caption text-grey">{{ users.filter(u => u.is_active !== false).length }} active</div>
                </div>
              </div>
              <v-btn color="primary" variant="flat" prepend-icon="mdi-account-plus-outline" @click="openNewUserDialog">
                New User
              </v-btn>
            </div>
          </v-card>

          <!-- Users table -->
          <v-card class="glass-card pa-0 mb-5">
            <v-data-table
              :headers="userHeaders"
              :items="users"
              :loading="loadingUsers"
              density="comfortable"
              class="transparent-table"
              no-data-text="No users found"
            >
              <template v-slot:item.role="{ item }">
                <v-chip
                  size="small"
                  :color="item.role === 'admin' ? 'primary' : 'grey'"
                  variant="tonal"
                >
                  {{ item.role }}
                </v-chip>
              </template>
              <template v-slot:item.authProvider="{ item }">
                <v-chip
                  v-if="item.authProvider && item.authProvider !== 'local'"
                  size="x-small"
                  :color="item.authProvider === 'saml' ? 'teal' : 'primary'"
                  variant="tonal"
                >
                  {{ item.authProvider.toUpperCase() }}
                </v-chip>
                <span v-else class="text-caption text-grey">local</span>
              </template>
              <template v-slot:item.is_active="{ item }">
                <v-chip
                  size="small"
                  :color="item.is_active !== false ? 'success' : 'error'"
                  variant="tonal"
                >
                  {{ item.is_active !== false ? 'Active' : 'Inactive' }}
                </v-chip>
              </template>
              <template v-slot:item.last_login="{ item }">
                <span class="text-caption">{{ item.last_login ? formatDateTime(item.last_login) : 'Never' }}</span>
              </template>
              <template v-slot:item.actions="{ item }">
                <div class="d-flex align-center gap-1">
                  <v-btn icon size="x-small" variant="text" color="primary" title="Edit user" @click="openEditUserDialog(item)">
                    <v-icon size="16">mdi-pencil-outline</v-icon>
                  </v-btn>
                  <v-btn
                    icon
                    size="x-small"
                    variant="text"
                    :color="item.is_active !== false ? 'error' : 'success'"
                    :title="item.is_active !== false ? 'Deactivate user' : 'Reactivate user'"
                    :disabled="item.id === currentUser.id"
                    @click="toggleUserActive(item)"
                  >
                    <v-icon size="16">{{ item.is_active !== false ? 'mdi-account-off-outline' : 'mdi-account-check-outline' }}</v-icon>
                  </v-btn>
                </div>
              </template>
            </v-data-table>
          </v-card>

          <!-- New User Dialog -->
          <v-dialog v-model="newUserDialog" max-width="480">
            <v-card class="glass-card">
              <v-card-title class="pa-5 pb-2 text-h6 font-weight-bold d-flex align-center">
                <v-icon start color="primary">mdi-account-plus-outline</v-icon>
                New User
              </v-card-title>
              <v-card-text class="pa-5">
                <v-text-field
                  v-model="newUserForm.username"
                  label="Username"
                  variant="outlined"
                  density="compact"
                  prepend-inner-icon="mdi-account-outline"
                  class="mb-3"
                  hide-details="auto"
                  :rules="[v => !!v || 'Username is required']"
                ></v-text-field>
                <v-text-field
                  v-model="newUserForm.email"
                  label="Email (optional)"
                  variant="outlined"
                  density="compact"
                  prepend-inner-icon="mdi-email-outline"
                  class="mb-3"
                  hide-details
                ></v-text-field>
                <v-text-field
                  v-model="newUserForm.password"
                  label="Password"
                  :type="showNewPassword ? 'text' : 'password'"
                  variant="outlined"
                  density="compact"
                  prepend-inner-icon="mdi-lock-outline"
                  :append-inner-icon="showNewPassword ? 'mdi-eye-off' : 'mdi-eye'"
                  @click:append-inner="showNewPassword = !showNewPassword"
                  class="mb-3"
                  hide-details="auto"
                  :rules="[v => !!v || 'Password is required', v => v.length >= 6 || 'Minimum 6 characters']"
                ></v-text-field>
                <v-select
                  v-model="newUserForm.role"
                  label="Role"
                  :items="[{ title: 'User', value: 'user' }, { title: 'Admin', value: 'admin' }]"
                  item-title="title"
                  item-value="value"
                  variant="outlined"
                  density="compact"
                  prepend-inner-icon="mdi-shield-outline"
                  hide-details
                ></v-select>
                <div v-if="newUserError" class="text-error text-caption mt-3">{{ newUserError }}</div>
              </v-card-text>
              <v-card-actions class="pa-5 pt-0 justify-end gap-2">
                <v-btn variant="text" color="grey" @click="newUserDialog = false">Cancel</v-btn>
                <v-btn variant="flat" color="primary" :loading="newUserSaving" @click="createUser">Save</v-btn>
              </v-card-actions>
            </v-card>
          </v-dialog>

          <!-- Edit User Dialog -->
          <v-dialog v-model="editUserDialog" max-width="480">
            <v-card class="glass-card" v-if="editUserTarget">
              <v-card-title class="pa-5 pb-2 text-h6 font-weight-bold d-flex align-center">
                <v-icon start color="primary">mdi-pencil-outline</v-icon>
                Edit User
              </v-card-title>
              <v-card-text class="pa-5">
                <div class="text-caption text-grey mb-1">Username</div>
                <div class="text-body-1 font-weight-bold mb-4 font-mono">{{ editUserTarget.username }}</div>
                <v-text-field
                  v-model="editUserForm.email"
                  label="Email"
                  variant="outlined"
                  density="compact"
                  prepend-inner-icon="mdi-email-outline"
                  class="mb-3"
                  hide-details
                ></v-text-field>
                <v-select
                  v-model="editUserForm.role"
                  label="Role"
                  :items="[{ title: 'User', value: 'user' }, { title: 'Admin', value: 'admin' }]"
                  item-title="title"
                  item-value="value"
                  variant="outlined"
                  density="compact"
                  prepend-inner-icon="mdi-shield-outline"
                  class="mb-3"
                  hide-details
                ></v-select>
                <v-switch
                  v-model="editUserForm.is_active"
                  :disabled="editUserTarget.id === currentUser.id"
                  label="Active"
                  color="success"
                  density="compact"
                  hide-details
                ></v-switch>
                <div v-if="editUserError" class="text-error text-caption mt-3">{{ editUserError }}</div>
              </v-card-text>
              <v-card-actions class="pa-5 pt-0 justify-end gap-2">
                <v-btn variant="text" color="grey" @click="editUserDialog = false">Cancel</v-btn>
                <v-btn variant="flat" color="primary" :loading="editUserSaving" @click="saveEditUser">Save</v-btn>
              </v-card-actions>
            </v-card>
          </v-dialog>

        </v-tabs-window-item>

        <!-- ===== AUTH PROVIDERS TAB ===== -->
        <v-tabs-window-item value="auth-providers">

          <!-- Local Auth -->
          <v-card class="glass-card pa-5 mb-5">
            <div class="section-heading mb-4">
              <v-icon color="primary" size="18" class="mr-2">mdi-lock-outline</v-icon>
              Local Authentication
            </div>
            <div class="d-flex align-center mb-3">
              <v-switch
                v-model="localAuthEnabled"
                label="Enable local username/password login"
                color="primary"
                hide-details
                density="compact"
                class="mr-3"
              ></v-switch>
            </div>
            <v-alert
              v-if="!localAuthEnabled"
              type="warning"
              variant="tonal"
              density="compact"
              class="mb-3 text-caption"
            >
              Ensure federated auth is configured before disabling local auth, or you may be locked out.
            </v-alert>
            <v-btn
              color="primary"
              variant="tonal"
              size="small"
              :loading="savingLocalAuth"
              prepend-icon="mdi-content-save-outline"
              @click="saveLocalAuth"
            >
              Save
            </v-btn>
          </v-card>

          <!-- OIDC Configuration -->
          <v-card class="glass-card pa-5 mb-5">
            <div class="section-heading mb-4">
              <v-icon color="primary" size="18" class="mr-2">mdi-openid</v-icon>
              OIDC Configuration
            </div>
            <div class="d-flex align-center mb-4">
              <v-switch
                v-model="oidcForm.enabled"
                label="Enable OIDC"
                color="primary"
                hide-details
                density="compact"
              ></v-switch>
            </div>

            <template v-if="oidcForm.enabled">
              <v-row>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="oidcForm.displayName"
                    label="Display Name"
                    hint="Shown on the login button, e.g. Google, Keycloak"
                    persistent-hint
                    variant="outlined"
                    density="compact"
                    class="mb-3"
                  ></v-text-field>
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="oidcForm.issuerUrl"
                    label="Issuer URL"
                    placeholder="https://accounts.google.com"
                    variant="outlined"
                    density="compact"
                    class="mb-3"
                    hide-details
                  ></v-text-field>
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="oidcForm.clientId"
                    label="Client ID"
                    variant="outlined"
                    density="compact"
                    class="mb-3"
                    hide-details
                  ></v-text-field>
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="oidcForm.clientSecret"
                    label="Client Secret (leave blank for public/PKCE clients)"
                    :type="showOidcSecret ? 'text' : 'password'"
                    :append-inner-icon="showOidcSecret ? 'mdi-eye-off' : 'mdi-eye'"
                    @click:append-inner="showOidcSecret = !showOidcSecret"
                    variant="outlined"
                    density="compact"
                    class="mb-1"
                    hide-details
                    persistent-hint
                  ></v-text-field>
                  <div class="text-caption text-grey mb-3">
                    Leave blank for Keycloak public clients. PKCE will be used automatically.
                  </div>
                </v-col>
                <v-col cols="12">
                  <v-text-field
                    v-model="oidcForm.redirectUri"
                    label="Redirect URI"
                    :placeholder="`${origin}/api/admin/oidc/callback`"
                    variant="outlined"
                    density="compact"
                    class="mb-3"
                    hide-details
                  ></v-text-field>
                </v-col>
              </v-row>

              <v-divider class="mb-4"></v-divider>

              <div class="d-flex align-center mb-3">
                <v-switch
                  v-model="oidcForm.autoProvision"
                  label="Auto-provision users on first login"
                  color="primary"
                  hide-details
                  density="compact"
                ></v-switch>
              </div>

              <v-row v-if="oidcForm.autoProvision">
                <v-col cols="12" sm="4">
                  <v-select
                    v-model="oidcForm.defaultRole"
                    label="Default Role"
                    :items="[{ title: 'User', value: 'user' }, { title: 'Admin', value: 'admin' }]"
                    item-title="title"
                    item-value="value"
                    variant="outlined"
                    density="compact"
                    hide-details
                  ></v-select>
                </v-col>
              </v-row>

              <v-divider class="my-4"></v-divider>

              <div class="text-subtitle-2 font-weight-medium mb-3">Claim Mapping</div>
              <v-row>
                <v-col cols="12" sm="4">
                  <v-text-field
                    v-model="oidcForm.usernameClaim"
                    label="Username Claim"
                    placeholder="preferred_username"
                    variant="outlined"
                    density="compact"
                    hide-details
                    class="mb-3"
                  ></v-text-field>
                </v-col>
                <v-col cols="12" sm="4">
                  <v-text-field
                    v-model="oidcForm.emailClaim"
                    label="Email Claim"
                    placeholder="email"
                    variant="outlined"
                    density="compact"
                    hide-details
                    class="mb-3"
                  ></v-text-field>
                </v-col>
                <v-col cols="12" sm="4">
                  <v-text-field
                    v-model="oidcForm.groupsClaim"
                    label="Groups Claim (optional)"
                    placeholder="groups"
                    variant="outlined"
                    density="compact"
                    hide-details
                    class="mb-3"
                  ></v-text-field>
                </v-col>
              </v-row>

              <!-- Group → Role mapping -->
              <div v-if="oidcForm.groupsClaim" class="mt-2">
                <div class="text-subtitle-2 font-weight-medium mb-2">Group → Role Mapping</div>
                <div v-for="(mapping, idx) in oidcForm.groupRoleMappings" :key="idx" class="d-flex align-center gap-2 mb-2">
                  <v-text-field
                    v-model="mapping.group"
                    label="OIDC Group"
                    variant="outlined"
                    density="compact"
                    hide-details
                    style="flex: 1"
                  ></v-text-field>
                  <v-icon color="grey">mdi-arrow-right</v-icon>
                  <v-select
                    v-model="mapping.role"
                    :items="[{ title: 'User', value: 'user' }, { title: 'Admin', value: 'admin' }]"
                    item-title="title"
                    item-value="value"
                    variant="outlined"
                    density="compact"
                    hide-details
                    style="max-width: 130px"
                  ></v-select>
                  <v-btn icon size="x-small" variant="text" color="error" @click="oidcForm.groupRoleMappings.splice(idx, 1)">
                    <v-icon size="16">mdi-close</v-icon>
                  </v-btn>
                </div>
                <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-plus" class="mt-1" @click="oidcForm.groupRoleMappings.push({ group: '', role: 'user' })">
                  Add Mapping
                </v-btn>
              </div>

              <v-divider class="my-4"></v-divider>

              <div class="d-flex align-center gap-3">
                <v-btn
                  variant="outlined"
                  color="primary"
                  size="small"
                  prepend-icon="mdi-lan-check"
                  :loading="testingOidc"
                  @click="testOidcConnection"
                >
                  Test Connection
                </v-btn>
                <v-chip v-if="oidcTestResult" :color="oidcTestResult.ok ? 'success' : 'error'" size="small" variant="tonal">
                  {{ oidcTestResult.message }}
                </v-chip>
              </div>
            </template>

            <div class="d-flex align-center gap-3 mt-4">
              <v-btn
                color="primary"
                variant="flat"
                size="small"
                :loading="savingOidc"
                prepend-icon="mdi-content-save-outline"
                @click="saveOidc"
              >
                Save OIDC
              </v-btn>
              <v-btn
                v-if="oidcForm.enabled"
                color="error"
                variant="tonal"
                size="small"
                prepend-icon="mdi-delete-outline"
                :loading="deletingOidc"
                @click="deleteOidc"
              >
                Disable OIDC
              </v-btn>
            </div>
          </v-card>

          <!-- SAML Configuration -->
          <v-card class="glass-card pa-5 mb-5">
            <div class="section-heading mb-4">
              <v-icon color="teal" size="18" class="mr-2">mdi-shield-key-outline</v-icon>
              SAML Configuration
            </div>
            <div class="d-flex align-center mb-4">
              <v-switch
                v-model="samlForm.enabled"
                label="Enable SAML"
                color="teal"
                hide-details
                density="compact"
              ></v-switch>
            </div>

            <template v-if="samlForm.enabled">
              <v-row>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="samlForm.displayName"
                    label="Display Name"
                    hint="Shown on the login button"
                    persistent-hint
                    variant="outlined"
                    density="compact"
                    class="mb-3"
                  ></v-text-field>
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="samlForm.idpMetadataUrl"
                    label="IdP Metadata URL (optional)"
                    placeholder="https://idp.example.com/metadata"
                    variant="outlined"
                    density="compact"
                    class="mb-3"
                    hide-details
                  ></v-text-field>
                </v-col>
                <v-col cols="12">
                  <v-textarea
                    v-model="samlForm.idpMetadataXml"
                    label="IdP Metadata XML (paste directly)"
                    hint="One of IdP Metadata URL or XML is required"
                    persistent-hint
                    variant="outlined"
                    density="compact"
                    rows="5"
                    class="mb-3 font-mono"
                    placeholder="<EntityDescriptor ...>...</EntityDescriptor>"
                  ></v-textarea>
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    :model-value="samlSpEntityId"
                    label="SP Entity ID (auto-generated)"
                    variant="outlined"
                    density="compact"
                    readonly
                    class="mb-3"
                    hide-details
                    append-inner-icon="mdi-lock-outline"
                  ></v-text-field>
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    :model-value="samlAcsUrl"
                    label="ACS URL (auto-generated)"
                    variant="outlined"
                    density="compact"
                    readonly
                    class="mb-3"
                    hide-details
                    append-inner-icon="mdi-lock-outline"
                  ></v-text-field>
                </v-col>
                <v-col cols="12">
                  <v-btn
                    variant="outlined"
                    color="teal"
                    size="small"
                    prepend-icon="mdi-download-outline"
                    @click="downloadSamlMetadata"
                  >
                    Download SP Metadata
                  </v-btn>
                </v-col>
              </v-row>

              <v-divider class="mb-4 mt-2"></v-divider>

              <div class="d-flex align-center mb-3">
                <v-switch
                  v-model="samlForm.autoProvision"
                  label="Auto-provision users on first login"
                  color="teal"
                  hide-details
                  density="compact"
                ></v-switch>
              </div>

              <v-row v-if="samlForm.autoProvision">
                <v-col cols="12" sm="4">
                  <v-select
                    v-model="samlForm.defaultRole"
                    label="Default Role"
                    :items="[{ title: 'User', value: 'user' }, { title: 'Admin', value: 'admin' }]"
                    item-title="title"
                    item-value="value"
                    variant="outlined"
                    density="compact"
                    hide-details
                  ></v-select>
                </v-col>
              </v-row>

              <v-divider class="my-4"></v-divider>

              <div class="text-subtitle-2 font-weight-medium mb-3">Attribute Mapping</div>
              <v-row>
                <v-col cols="12" sm="4">
                  <v-text-field
                    v-model="samlForm.usernameAttr"
                    label="Username Attribute"
                    placeholder="uid"
                    variant="outlined"
                    density="compact"
                    hide-details
                    class="mb-3"
                  ></v-text-field>
                </v-col>
                <v-col cols="12" sm="4">
                  <v-text-field
                    v-model="samlForm.emailAttr"
                    label="Email Attribute"
                    placeholder="email"
                    variant="outlined"
                    density="compact"
                    hide-details
                    class="mb-3"
                  ></v-text-field>
                </v-col>
                <v-col cols="12" sm="4">
                  <v-text-field
                    v-model="samlForm.groupsAttr"
                    label="Groups Attribute (optional)"
                    placeholder="memberOf"
                    variant="outlined"
                    density="compact"
                    hide-details
                    class="mb-3"
                  ></v-text-field>
                </v-col>
              </v-row>

              <!-- Group → Role mapping -->
              <div v-if="samlForm.groupsAttr" class="mt-2">
                <div class="text-subtitle-2 font-weight-medium mb-2">Group → Role Mapping</div>
                <div v-for="(mapping, idx) in samlForm.groupRoleMappings" :key="idx" class="d-flex align-center gap-2 mb-2">
                  <v-text-field
                    v-model="mapping.group"
                    label="SAML Group"
                    variant="outlined"
                    density="compact"
                    hide-details
                    style="flex: 1"
                  ></v-text-field>
                  <v-icon color="grey">mdi-arrow-right</v-icon>
                  <v-select
                    v-model="mapping.role"
                    :items="[{ title: 'User', value: 'user' }, { title: 'Admin', value: 'admin' }]"
                    item-title="title"
                    item-value="value"
                    variant="outlined"
                    density="compact"
                    hide-details
                    style="max-width: 130px"
                  ></v-select>
                  <v-btn icon size="x-small" variant="text" color="error" @click="samlForm.groupRoleMappings.splice(idx, 1)">
                    <v-icon size="16">mdi-close</v-icon>
                  </v-btn>
                </div>
                <v-btn size="small" variant="tonal" color="teal" prepend-icon="mdi-plus" class="mt-1" @click="samlForm.groupRoleMappings.push({ group: '', role: 'user' })">
                  Add Mapping
                </v-btn>
              </div>
            </template>

            <div class="d-flex align-center gap-3 mt-4">
              <v-btn
                color="primary"
                variant="flat"
                size="small"
                :loading="savingSaml"
                prepend-icon="mdi-content-save-outline"
                @click="saveSaml"
              >
                Save SAML
              </v-btn>
              <v-btn
                v-if="samlForm.enabled"
                color="error"
                variant="tonal"
                size="small"
                prepend-icon="mdi-delete-outline"
                :loading="deletingSaml"
                @click="deleteSaml"
              >
                Disable SAML
              </v-btn>
            </div>
          </v-card>

        </v-tabs-window-item>

        <!-- ===== AUDIT LOG TAB ===== -->
        <v-tabs-window-item value="audit-log">
          <v-card class="glass-card pa-0 mb-5">
            <div class="d-flex align-center justify-space-between pa-4 border-bottom">
              <div class="text-h6 font-weight-bold d-flex align-center">
                <v-icon start color="primary">mdi-clipboard-text-clock-outline</v-icon>
                Audit Log
              </div>
              <div class="d-flex align-center gap-2">
                <span class="text-caption text-grey">Auto-refreshes every 30s</span>
                <v-btn icon size="small" variant="text" color="primary" :loading="loadingAuditLog" @click="fetchAuditLog">
                  <v-icon>mdi-refresh</v-icon>
                </v-btn>
              </div>
            </div>
            <v-data-table
              :headers="auditHeaders"
              :items="auditLog"
              :loading="loadingAuditLog"
              density="comfortable"
              class="transparent-table"
              no-data-text="No audit log entries"
            >
              <template v-slot:item.timestamp="{ item }">
                <span class="text-caption font-mono">{{ formatDateTime(item.timestamp) }}</span>
              </template>
              <template v-slot:item.action="{ item }">
                <v-chip size="x-small" variant="tonal" color="primary">{{ item.action }}</v-chip>
              </template>
            </v-data-table>
          </v-card>
        </v-tabs-window-item>

      </v-tabs-window>
    </v-container>
  </v-main>
</template>

<script>
import AppNav from '../components/AppNav.vue';

export default {
  name: 'SiteManagement',
  components: { AppNav },
  data: () => ({
    tab: 'users',
    currentUser: { username: 'admin', role: 'admin', authProvider: 'local' },
    appVersion: __APP_VERSION__,
    themeName: localStorage.getItem('orkllm-theme') || 'customDarkTheme',

    snackbar: { show: false, text: '', color: 'success' },

    // Users
    users: [],
    loadingUsers: false,
    userHeaders: [
      { title: 'Username', key: 'username', sortable: true },
      { title: 'Email', key: 'email', sortable: false },
      { title: 'Role', key: 'role', sortable: true },
      { title: 'Provider', key: 'authProvider', sortable: false },
      { title: 'Status', key: 'is_active', sortable: false },
      { title: 'Last Login', key: 'last_login', sortable: true },
      { title: 'Actions', key: 'actions', sortable: false },
    ],

    // New user dialog
    newUserDialog: false,
    newUserSaving: false,
    newUserError: '',
    showNewPassword: false,
    newUserForm: { username: '', email: '', password: '', role: 'user' },

    // Edit user dialog
    editUserDialog: false,
    editUserSaving: false,
    editUserError: '',
    editUserTarget: null,
    editUserForm: { email: '', role: 'user', is_active: true },

    // Auth providers
    oidcForm: {
      enabled: false,
      displayName: '',
      issuerUrl: '',
      clientId: '',
      clientSecret: '',
      redirectUri: '',
      autoProvision: false,
      defaultRole: 'user',
      usernameClaim: 'preferred_username',
      emailClaim: 'email',
      groupsClaim: '',
      groupRoleMappings: [],
    },
    showOidcSecret: false,
    savingOidc: false,
    deletingOidc: false,
    testingOidc: false,
    oidcTestResult: null,

    samlForm: {
      enabled: false,
      displayName: '',
      idpMetadataUrl: '',
      idpMetadataXml: '',
      autoProvision: false,
      defaultRole: 'user',
      usernameAttr: 'uid',
      emailAttr: 'email',
      groupsAttr: '',
      groupRoleMappings: [],
    },
    savingSaml: false,
    deletingSaml: false,

    // Local auth
    localAuthEnabled: true,
    savingLocalAuth: false,

    // Audit log
    auditLog: [],
    loadingAuditLog: false,
    auditHeaders: [
      { title: 'Timestamp', key: 'timestamp', sortable: true },
      { title: 'User', key: 'user', sortable: true },
      { title: 'Action', key: 'action', sortable: true },
      { title: 'Resource', key: 'resource', sortable: false },
      { title: 'IP Address', key: 'ip', sortable: false },
    ],
    auditRefreshTimer: null,
  }),
  computed: {
    isDark() {
      return this.themeName === 'customDarkTheme';
    },
    origin() {
      return window.location.origin;
    },
    samlSpEntityId() {
      return `${window.location.origin}/api/admin/saml/metadata`;
    },
    samlAcsUrl() {
      return `${window.location.origin}/api/admin/saml/acs`;
    },
  },
  async mounted() {
    await this.fetchAuth();
    this.fetchUsers();
    this.fetchAuthProvider();
    this.fetchGlobalSettings();
    this.fetchAuditLog();
    this.auditRefreshTimer = setInterval(() => this.fetchAuditLog(), 30000);
  },
  beforeUnmount() {
    if (this.auditRefreshTimer) clearInterval(this.auditRefreshTimer);
  },
  methods: {
    async fetchAuth() {
      try {
        const res = await fetch('/api/admin/auth-status');
        const data = await res.json();
        if (data.user) this.currentUser = data.user;
        else if (data.username) this.currentUser = { username: data.username, role: 'admin', authProvider: 'local' };
      } catch (e) {}
    },
    async fetchUsers() {
      this.loadingUsers = true;
      try {
        const res = await fetch('/api/admin/users');
        if (res.ok) {
          const data = await res.json();
          this.users = data.users || data || [];
        }
      } catch (e) {} finally {
        this.loadingUsers = false;
      }
    },
    async fetchAuthProvider() {
      try {
        const res = await fetch('/api/admin/auth-provider');
        if (!res.ok) return;
        const data = await res.json();
        if (data.providerType === 'oidc') {
          this.oidcForm.enabled = true;
          const c = data.config || {};
          this.oidcForm.displayName = c.displayName || '';
          this.oidcForm.issuerUrl = c.issuerUrl || '';
          this.oidcForm.clientId = c.clientId || '';
          this.oidcForm.clientSecret = c.clientSecret || '';
          this.oidcForm.redirectUri = c.redirectUri || '';
          this.oidcForm.autoProvision = c.autoProvision || false;
          this.oidcForm.defaultRole = c.defaultRole || 'user';
          this.oidcForm.usernameClaim = c.usernameClaim || 'preferred_username';
          this.oidcForm.emailClaim = c.emailClaim || 'email';
          this.oidcForm.groupsClaim = c.groupsClaim || '';
          this.oidcForm.groupRoleMappings = c.groupRoleMappings || [];
        } else if (data.providerType === 'saml') {
          this.samlForm.enabled = true;
          const c = data.config || {};
          this.samlForm.displayName = c.displayName || '';
          this.samlForm.idpMetadataUrl = c.idpMetadataUrl || '';
          this.samlForm.idpMetadataXml = c.idpMetadataXml || '';
          this.samlForm.autoProvision = c.autoProvision || false;
          this.samlForm.defaultRole = c.defaultRole || 'user';
          this.samlForm.usernameAttr = c.usernameAttr || 'uid';
          this.samlForm.emailAttr = c.emailAttr || 'email';
          this.samlForm.groupsAttr = c.groupsAttr || '';
          this.samlForm.groupRoleMappings = c.groupRoleMappings || [];
        }
      } catch (e) {}
    },
    async fetchGlobalSettings() {
      try {
        const res = await fetch('/api/admin/global-settings');
        if (!res.ok) return;
        const data = await res.json();
        const localAuthDisabled = data.settings?.localAuthDisabled ?? false;
        this.localAuthEnabled = !localAuthDisabled;
      } catch (e) {}
    },
    async fetchAuditLog() {
      this.loadingAuditLog = true;
      try {
        const res = await fetch('/api/admin/audit-log');
        if (res.ok) {
          const data = await res.json();
          this.auditLog = (data.entries || data || []).slice(0, 200);
        }
      } catch (e) {} finally {
        this.loadingAuditLog = false;
      }
    },

    // Users
    openNewUserDialog() {
      this.newUserForm = { username: '', email: '', password: '', role: 'user' };
      this.newUserError = '';
      this.showNewPassword = false;
      this.newUserDialog = true;
    },
    async createUser() {
      this.newUserError = '';
      if (!this.newUserForm.username) { this.newUserError = 'Username is required.'; return; }
      if (!this.newUserForm.password || this.newUserForm.password.length < 6) { this.newUserError = 'Password must be at least 6 characters.'; return; }
      this.newUserSaving = true;
      try {
        const res = await fetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.newUserForm),
        });
        if (res.ok) {
          this.newUserDialog = false;
          this.notify('User created successfully', 'success');
          await this.fetchUsers();
        } else {
          const d = await res.json();
          this.newUserError = d.error || 'Failed to create user';
        }
      } catch (e) {
        this.newUserError = 'Network error';
      } finally {
        this.newUserSaving = false;
      }
    },
    openEditUserDialog(user) {
      this.editUserTarget = user;
      this.editUserForm = { email: user.email || '', role: user.role || 'user', is_active: user.is_active !== false };
      this.editUserError = '';
      this.editUserDialog = true;
    },
    async saveEditUser() {
      if (!this.editUserTarget) return;
      this.editUserSaving = true;
      this.editUserError = '';
      try {
        const res = await fetch(`/api/admin/users/${this.editUserTarget.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.editUserForm),
        });
        if (res.ok) {
          this.editUserDialog = false;
          this.notify('User updated', 'success');
          await this.fetchUsers();
        } else {
          const d = await res.json();
          this.editUserError = d.error || 'Failed to update user';
        }
      } catch (e) {
        this.editUserError = 'Network error';
      } finally {
        this.editUserSaving = false;
      }
    },
    async toggleUserActive(user) {
      try {
        const res = await fetch(`/api/admin/users/${user.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: user.is_active === false }),
        });
        if (res.ok) {
          this.notify(`User ${user.is_active === false ? 'reactivated' : 'deactivated'}`, 'success');
          await this.fetchUsers();
        } else {
          const d = await res.json();
          this.notify(d.error || 'Failed to update user', 'error');
        }
      } catch (e) {
        this.notify('Network error', 'error');
      }
    },

    // Local auth
    async saveLocalAuth() {
      this.savingLocalAuth = true;
      try {
        const res = await fetch('/api/admin/global-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localAuthDisabled: !this.localAuthEnabled }),
        });
        if (res.ok) {
          this.notify('Local auth setting saved', 'success');
        } else {
          const d = await res.json();
          this.notify(d.error || 'Failed to save', 'error');
        }
      } catch (e) {
        this.notify('Network error', 'error');
      } finally {
        this.savingLocalAuth = false;
      }
    },

    // OIDC
    async testOidcConnection() {
      if (!this.oidcForm.issuerUrl) return;
      this.testingOidc = true;
      this.oidcTestResult = null;
      try {
        const url = this.oidcForm.issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
        const res = await fetch(url);
        if (res.ok) {
          this.oidcTestResult = { ok: true, message: 'Connection successful' };
        } else {
          this.oidcTestResult = { ok: false, message: `HTTP ${res.status}` };
        }
      } catch (e) {
        this.oidcTestResult = { ok: false, message: e.message || 'Connection failed' };
      } finally {
        this.testingOidc = false;
      }
    },
    async saveOidc() {
      this.savingOidc = true;
      try {
        const body = this.oidcForm.enabled
          ? { providerType: 'oidc', config: { ...this.oidcForm } }
          : null;
        if (!body) { await this.deleteOidc(); return; }
        const res = await fetch('/api/admin/auth-provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          this.notify('OIDC configuration saved', 'success');
        } else {
          const d = await res.json();
          this.notify(d.error || 'Failed to save OIDC', 'error');
        }
      } catch (e) {
        this.notify('Network error', 'error');
      } finally {
        this.savingOidc = false;
      }
    },
    async deleteOidc() {
      this.deletingOidc = true;
      try {
        const res = await fetch('/api/admin/auth-provider', { method: 'DELETE' });
        if (res.ok) {
          this.oidcForm.enabled = false;
          this.notify('OIDC disabled', 'success');
        } else {
          const d = await res.json();
          this.notify(d.error || 'Failed to disable OIDC', 'error');
        }
      } catch (e) {
        this.notify('Network error', 'error');
      } finally {
        this.deletingOidc = false;
      }
    },

    // SAML
    downloadSamlMetadata() {
      window.open('/api/admin/saml/metadata', '_blank');
    },
    async saveSaml() {
      this.savingSaml = true;
      try {
        const body = this.samlForm.enabled
          ? { providerType: 'saml', config: { ...this.samlForm } }
          : null;
        if (!body) { await this.deleteSaml(); return; }
        const res = await fetch('/api/admin/auth-provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          this.notify('SAML configuration saved', 'success');
        } else {
          const d = await res.json();
          this.notify(d.error || 'Failed to save SAML', 'error');
        }
      } catch (e) {
        this.notify('Network error', 'error');
      } finally {
        this.savingSaml = false;
      }
    },
    async deleteSaml() {
      this.deletingSaml = true;
      try {
        const res = await fetch('/api/admin/auth-provider', { method: 'DELETE' });
        if (res.ok) {
          this.samlForm.enabled = false;
          this.notify('SAML disabled', 'success');
        } else {
          const d = await res.json();
          this.notify(d.error || 'Failed to disable SAML', 'error');
        }
      } catch (e) {
        this.notify('Network error', 'error');
      } finally {
        this.deletingSaml = false;
      }
    },

    // Utilities
    formatDateTime(ts) {
      if (!ts) return '';
      try {
        return new Date(ts).toLocaleString();
      } catch (e) {
        return ts;
      }
    },
    notify(text, color = 'success') {
      this.snackbar = { show: true, text, color };
    },
    toggleTheme() {
      const next = this.isDark ? 'customLightTheme' : 'customDarkTheme';
      this.themeName = next;
      localStorage.setItem('orkllm-theme', next);
      try {
        this.$vuetify.theme.global.name.value = next;
      } catch {
        this.$vuetify.theme.global.name = next;
      }
    },
    async logout() {
      try {
        await fetch('/api/admin/logout', { method: 'POST' });
        this.$router.push('/login');
      } catch (e) {}
    },
  },
};
</script>

<style scoped>
.bg-slate-page {
  background: #0B0F19 !important;
}
.v-theme--customLightTheme .bg-slate-page {
  background: #F1F5F9 !important;
}

.glass-card {
  background: rgba(17, 24, 39, 0.7) !important;
  backdrop-filter: blur(16px);
  border: 1px solid rgba(139, 92, 246, 0.15) !important;
  border-radius: 12px !important;
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

.section-heading {
  font-size: 0.875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(139, 92, 246, 0.9);
  display: flex;
  align-items: center;
}

.border-bottom {
  border-bottom: 1px solid rgba(139, 92, 246, 0.1) !important;
}

.transparent-table {
  background: transparent !important;
}

.font-mono {
  font-family: 'Fira Code', 'Courier New', monospace;
}

.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }
.gap-3 { gap: 12px; }
</style>
