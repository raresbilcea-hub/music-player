import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/auth';

export default function RegisterScreen() {
  const router = useRouter();
  const { signUp } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleRegister() {
    if (!email.trim() || !password || !confirm) {
      setError('Please fill in all fields.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setError('');
    setLoading(true);
    const { error } = await signUp(email.trim(), password);
    setLoading(false);
    if (error) {
      setError(error);
    } else {
      setDone(true);
    }
  }

  if (done) {
    return (
      <View style={styles.root}>
        <View style={styles.doneContainer}>
          <Text style={styles.doneIcon}>✦</Text>
          <Text style={styles.doneTitle}>Check your email</Text>
          <Text style={styles.doneBody}>
            We sent a confirmation link to{'\n'}
            <Text style={styles.doneEmail}>{email}</Text>
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.replace('/login')}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryBtnText}>BACK TO SIGN IN</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headingMain}>Create</Text>
          <Text style={styles.headingAccent}>Account.</Text>
          <Text style={styles.tagline}>Join Music Player 2.0</Text>
        </View>

        {/* Form */}
        <View style={styles.form}>
          <Text style={styles.label}>EMAIL</Text>
          <TextInput
            style={styles.input}
            placeholder="your@email.com"
            placeholderTextColor="#3d3528"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            returnKeyType="next"
          />

          <Text style={styles.label}>PASSWORD</Text>
          <TextInput
            style={styles.input}
            placeholder="••••••••"
            placeholderTextColor="#3d3528"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            returnKeyType="next"
          />

          <Text style={styles.label}>CONFIRM PASSWORD</Text>
          <TextInput
            style={styles.input}
            placeholder="••••••••"
            placeholderTextColor="#3d3528"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            returnKeyType="done"
            onSubmitEditing={handleRegister}
          />

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.primaryBtn, loading && styles.primaryBtnDisabled]}
            onPress={handleRegister}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#0e0c09" />
              : <Text style={styles.primaryBtnText}>CREATE ACCOUNT</Text>
            }
          </TouchableOpacity>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have an account? </Text>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={styles.footerLink}>Sign In</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0e0c09',
  },
  inner: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 80,
    paddingBottom: 40,
    justifyContent: 'space-between',
  },

  header: {
    marginBottom: 48,
  },
  headingMain: {
    color: '#e8dfc8',
    fontSize: 52,
    fontWeight: 'bold',
    lineHeight: 56,
  },
  headingAccent: {
    color: '#c9a84c',
    fontSize: 52,
    fontStyle: 'italic',
    lineHeight: 56,
    marginBottom: 12,
  },
  tagline: {
    color: '#6b6254',
    fontSize: 14,
  },

  form: {
    flex: 1,
  },
  label: {
    color: '#8a6f32',
    fontSize: 9,
    letterSpacing: 2.5,
    marginBottom: 8,
    marginTop: 20,
  },
  input: {
    backgroundColor: '#16130e',
    color: '#e8dfc8',
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#2a2318',
  },
  errorText: {
    color: '#c0392b',
    fontSize: 13,
    marginTop: 16,
    marginBottom: 4,
  },
  primaryBtn: {
    backgroundColor: '#c9a84c',
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 32,
  },
  primaryBtnDisabled: {
    opacity: 0.6,
  },
  primaryBtnText: {
    color: '#0e0c09',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2.5,
  },

  // Success state
  doneContainer: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 120,
    alignItems: 'center',
  },
  doneIcon: {
    color: '#c9a84c',
    fontSize: 36,
    marginBottom: 32,
  },
  doneTitle: {
    color: '#e8dfc8',
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  doneBody: {
    color: '#6b6254',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 48,
  },
  doneEmail: {
    color: '#c9a84c',
  },

  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingTop: 24,
  },
  footerText: {
    color: '#6b6254',
    fontSize: 14,
  },
  footerLink: {
    color: '#c9a84c',
    fontSize: 14,
  },
});
