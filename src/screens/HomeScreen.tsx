import React, { useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { Button } from '../components/Button';
import { useUserStore } from '../store/userStore';
import { useTheme } from '../theme';

export const HomeScreen = ({ navigation }: any) => {
  const t = useTheme();
  const { uid, setUid } = useUserStore();
  const [input, setInput] = useState(uid);

  const onEnter = () => {
    if (!/^\d{1,20}$/.test(input)) {
      Alert.alert('提示', '请输入合法的 UID（纯数字）');
      return;
    }
    setUid(input);
    navigation.navigate('Folders');
  };

  const s = StyleSheet.create({
    container: {
      flex: 1, padding: t.spacing.xl, backgroundColor: t.colors.background,
      justifyContent: 'center',
    },
    iconWrap: {
      width: 80, height: 80, borderRadius: 20, backgroundColor: t.colors.primaryLight,
      alignSelf: 'center', alignItems: 'center', justifyContent: 'center',
      marginBottom: t.spacing.xl,
    },
    title: {
      fontSize: t.fontSize.xxl, fontWeight: 'bold',
      color: t.colors.text, textAlign: 'center',
    },
    subtitle: {
      fontSize: t.fontSize.sm, color: t.colors.textSub,
      textAlign: 'center', marginTop: t.spacing.sm, marginBottom: t.spacing.xxl,
    },
    input: {
      height: 48, borderWidth: 1, borderColor: t.colors.divider,
      borderRadius: t.radius.lg, paddingHorizontal: t.spacing.lg,
      fontSize: t.fontSize.md, color: t.colors.text,
      backgroundColor: t.colors.surface,
    },
    enter: { marginTop: t.spacing.lg },
    settingsBtn: { alignSelf: 'center', marginTop: t.spacing.xl },
    settingsBtnText: { color: t.colors.textSub, fontSize: t.fontSize.sm },
  });

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={s.container}
    >
      <View style={s.iconWrap}>
        <Icon name="music" size={44} color={t.colors.primary} />
      </View>
      <Text style={s.title}>B 站音乐</Text>
      <Text style={s.subtitle}>离线收听你的收藏</Text>
      <TextInput
        style={s.input}
        placeholder="请输入 B 站 UID"
        placeholderTextColor={t.colors.textHint}
        keyboardType="numeric"
        value={input}
        onChangeText={setInput}
        returnKeyType="go"
        onSubmitEditing={onEnter}
      />
      <Button title="进入" onPress={onEnter} style={s.enter} />
      <Text
        style={[s.settingsBtnText, s.settingsBtn]}
        onPress={() => navigation.navigate('Settings')}
      >
        设置
      </Text>
    </KeyboardAvoidingView>
  );
};
