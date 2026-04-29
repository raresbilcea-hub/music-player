import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { TouchableOpacity, Text, View, StyleSheet } from 'react-native';

import { HapticTab } from '@/components/haptic-tab';
import { useAuth } from '@/context/auth';

const GOLD   = '#c9a84c';
const GOLD_DIM = '#8a6f32';
const MUTED  = '#6b6254';
const BG     = '#0e0c09';
const BORDER = '#2a2318';
const RED    = '#c0392b';

function AuthHeaderButton() {
  const { user, signOut } = useAuth();
  const router = useRouter();

  if (user) {
    return (
      <View style={hb.row}>
        <Text style={hb.email} numberOfLines={1}>
          {user.email?.split('@')[0]}
        </Text>
        <TouchableOpacity onPress={() => signOut()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={hb.signOut}>SIGN OUT</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <TouchableOpacity
      onPress={() => router.push('/login')}
      style={hb.signInBtn}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Text style={hb.signIn}>SIGN IN</Text>
    </TouchableOpacity>
  );
}

const hb = StyleSheet.create({
  row:       { flexDirection: 'row', alignItems: 'center', gap: 10, marginRight: 16 },
  email:     { color: MUTED, fontSize: 11, maxWidth: 110 },
  signOut:   { color: GOLD_DIM, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  signInBtn: { marginRight: 16 },
  signIn:    { color: GOLD, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
});

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown:             true,
        headerStyle:             { backgroundColor: BG },
        headerShadowVisible:     false,
        headerTitleStyle:        { color: GOLD, fontSize: 13, letterSpacing: 1, fontWeight: '600' },
        headerRight:             () => <AuthHeaderButton />,
        tabBarButton:            HapticTab,
        tabBarActiveTintColor:   GOLD,
        tabBarInactiveTintColor: MUTED,
        tabBarStyle: {
          backgroundColor: BG,
          borderTopColor:  BORDER,
          borderTopWidth:  1,
        },
        tabBarLabelStyle: {
          fontSize:      11,
          letterSpacing: 0.5,
          marginBottom:  2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => (
            <Ionicons name="home-outline" size={25} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Lessons',
          tabBarIcon: ({ color }) => (
            <Ionicons name="school-outline" size={25} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="song"
        options={{
          title: 'Songs',
          tabBarIcon: ({ color }) => (
            <Ionicons name="time-outline" size={25} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="record"
        options={{
          title: 'Record',
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name="radio-button-on"
              size={27}
              color={focused ? RED : MUTED}
            />
          ),
        }}
      />
    </Tabs>
  );
}
