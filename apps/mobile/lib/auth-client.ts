import Constants from "expo-constants";
import { getItem, getItemAsync, setItem, setItemAsync } from "expo-secure-store";
import { createAuthClient } from "better-auth/react";
import { expoClient } from "@better-auth/expo/client";

/**
 * Client-side Better Auth instance for the native app. Mirrors
 * apps/web/lib/auth-client.ts's role, but points at the deployed backend
 * (EXPO_PUBLIC_API_URL / app.config.ts's `extra.apiUrl`) instead of same
 * -origin, and persists the session cookie in SecureStore via the
 * `expoClient` plugin rather than a browser cookie jar — see
 * apps/web/lib/auth.ts's `expo()` server plugin, which this pairs with.
 */
export const authClient = createAuthClient({
  baseURL: Constants.expoConfig?.extra?.apiUrl as string,
  plugins: [
    expoClient({
      scheme: "signaller",
      storagePrefix: "signaller",
      storage: { getItem, setItem, getItemAsync, setItemAsync },
    }),
  ],
});
