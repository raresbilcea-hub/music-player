import { Stack, useRouter, useSegments, useRootNavigationState } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { AuthProvider, useAuth } from '@/context/auth';

function RootLayoutNav() {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const navigationState = useRootNavigationState();

  useEffect(() => {
    if (!navigationState?.key || loading) return;

    const inAuthScreen = segments[0] === 'login' || segments[0] === 'register';

    // Only redirect away from auth screens when already signed in — never force login
    if (session && inAuthScreen) {
      router.replace('/(tabs)');
    }
  }, [session, loading, segments, navigationState?.key]);

  return (
    <>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="register" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
        <Stack.Screen
          name="record-lesson"
          options={{
            presentation:    'modal',
            headerShown:     false,
            animation:       'slide_from_bottom',
            contentStyle:    { backgroundColor: '#0e0c09' },
          }}
        />
        <Stack.Screen
          name="profile"
          options={{
            title: 'Profile',
            presentation: 'modal',
            headerStyle: { backgroundColor: '#0e0c09' },
            headerTintColor: '#c9a84c',
            headerTitleStyle: { color: '#c9a84c', fontSize: 13, fontWeight: '600' },
            headerShadowVisible: false,
          }}
        />
      </Stack>
      <StatusBar style="light" />
    </>
  );
}

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootLayoutNav />
    </AuthProvider>
  );
}
