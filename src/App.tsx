import React, { useEffect } from 'react';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useColorScheme } from 'react-native';
import { ThemeProvider } from './theme';
import { setupPlayer } from './services/trackPlayer';
import { netStatus } from './services/netStatus';
import { HomeScreen } from './screens/HomeScreen';
import { FoldersScreen } from './screens/FoldersScreen';
import { VideosScreen } from './screens/VideosScreen';
import { PlayerScreen } from './screens/PlayerScreen';
import { SettingsScreen } from './screens/SettingsScreen';

const Stack = createNativeStackNavigator();

export default function App() {
  const isDark = useColorScheme() === 'dark';

  useEffect(() => {
    setupPlayer();
    netStatus.init();
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <NavigationContainer theme={isDark ? DarkTheme : DefaultTheme}>
          <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
            <Stack.Screen name="Home" component={HomeScreen} />
            <Stack.Screen name="Folders" component={FoldersScreen} />
            <Stack.Screen name="Videos" component={VideosScreen} />
            <Stack.Screen
              name="Player"
              component={PlayerScreen}
              options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
            />
            <Stack.Screen name="Settings" component={SettingsScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
