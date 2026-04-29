import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/lib/supabase';

const KEY = '@mp_free_used';

// Returns true if the user has consumed their free action AND is not logged in.
export async function shouldShowGate(): Promise<boolean> {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return false;
  const val = await AsyncStorage.getItem(KEY);
  return val === 'true';
}

// Call this after the first free action completes successfully.
export async function consumeFreeAction(): Promise<void> {
  await AsyncStorage.setItem(KEY, 'true');
}

// Called when the user signs in/up — clear the gate so it never shows again.
export async function clearGate(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
