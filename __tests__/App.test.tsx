/**
 * @format
 */

jest.mock('react-native', () => {
  const ReactNative = jest.requireActual('react-native');
  // Extend the mock with NativeModules to provide SettingsManager and any other native modules required
  const mockedNativeModules = {
    ...(ReactNative.NativeModules || {}),
    SettingsManager: {
      // Mock getConstants to return an empty settings object
      getConstants: () => ({}),
    },
    // Add other native module stubs if needed to avoid missing module errors
    // For example, NativeSettingsManager may be used internally; provide a basic mock
    NativeSettingsManager: {
      getConstants: () => ({}),
    },
  };

  return {
    ...ReactNative,
    NativeModules: mockedNativeModules,
    // Provide a dummy Settings export to avoid native module errors in tests
    Settings: {
      get: jest.fn(),
      set: jest.fn(),
      watchKeys: jest.fn(),
      clearWatch: jest.fn(),
    },
    BackHandler: {
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    },
    Platform: { OS: 'android', select: jest.fn() },
    ToastAndroid: { show: jest.fn(), SHORT: 0 },
    Alert: { alert: jest.fn() },
    useColorScheme: jest.fn(() => 'light'),
  };
});
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    GestureHandlerRootView: View,
    __esModule: true,
  };
});
// Mock navigation modules for Jest environment
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    NavigationContainer: ({ children }) => <>{children}</>,
    useNavigationContainerRef: () => ({
      isReady: () => false,
      canGoBack: () => false,
      goBack: () => {},
    }),
    DefaultTheme: {},
    DarkTheme: {},
    __esModule: true,
  };
});

// Mock netinfo module
jest.mock('@react-native-community/netinfo', () => {
  return {
    __esModule: true,
    default: {
      addEventListener: jest.fn(),
      fetch: jest.fn(() => Promise.resolve({ isConnected: true, type: 'wifi' })),
    },
  };
});

jest.mock('@react-navigation/native-stack', () => {
  return {
    createNativeStackNavigator: () => ({
      Navigator: ({ children }) => <>{children}</>,
      Screen: () => null,
    }),
    __esModule: true,
  };
});

jest.mock('@react-navigation/stack', () => {
  return {
    createStackNavigator: () => ({
      Navigator: ({ children }) => <>{children}</>,
      Screen: () => null,
    }),
    __esModule: true,
  };
});

// Mock Settings module to avoid native SettingsManager errors
jest.mock('react-native/Libraries/Settings/Settings', () => ({
  get: jest.fn(),
  set: jest.fn(),
  watchKeys: jest.fn(),
  clearWatch: jest.fn(),
}));

// Mock NativeSettingsManager to provide getConstants stub
jest.mock('react-native/Libraries/Settings/NativeSettingsManager', () => ({
  getConstants: () => ({ settings: {} }),
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaProvider: ({ children }) => <>{children}</>,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    __esModule: true,
  };
});

jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  // Override the default `call` implementation to avoid warnings
  Reanimated.default.call = () => {};
  return Reanimated;
});

// Mock react-native-fs for Jest environment
jest.mock('react-native-fs', () => {
  return {
    __esModule: true,
    default: {
      DocumentDirectoryPath: '/mock/doc',
      exists: jest.fn(() => Promise.resolve(true)),
      mkdir: jest.fn(() => Promise.resolve()),
      downloadFile: jest.fn(() => ({ promise: Promise.resolve({ statusCode: 200 }) })),
      stat: jest.fn(() => Promise.resolve({ size: 12345 })),
      readDir: jest.fn(() => Promise.resolve([])),
      unlink: jest.fn(() => Promise.resolve()),
    },
  };
});

// Mock react-native-track-player for Jest environment
jest.mock('react-native-track-player', () => {
  const mock = {
    setupPlayer: jest.fn(() => Promise.resolve()),
    updateOptions: jest.fn(() => Promise.resolve()),
    add: jest.fn(() => Promise.resolve()),
    reset: jest.fn(() => Promise.resolve()),
    skip: jest.fn(() => Promise.resolve()),
    skipToNext: jest.fn(() => Promise.resolve()),
    remove: jest.fn(() => Promise.resolve()),
    getQueue: jest.fn(() => Promise.resolve([])),
    getActiveTrackIndex: jest.fn(() => Promise.resolve(-1)),
  };
  return {
    __esModule: true,
    default: mock,
    AppKilledPlaybackBehavior: {},
    Capability: { Play: 'Play', Pause: 'Pause', SkipToNext: 'SkipToNext', SkipToPrevious: 'SkipToPrevious', SeekTo: 'SeekTo', Stop: 'Stop' },
    Event: {},
    State: {},
  };
});

import React from 'react';

// Mock @react-native-cookies/cookies for Jest environment
jest.mock('@react-native-cookies/cookies', () => ({
  __esModule: true,
  default: {
    get: jest.fn(() => Promise.resolve({})),
    set: jest.fn(() => Promise.resolve()),
    clear: jest.fn(() => Promise.resolve()),
  },
}));

// Mock react-native-keychain for Jest environment
jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(() => Promise.resolve(true)),
  getGenericPassword: jest.fn(() => Promise.resolve(false)),
  resetGenericPassword: jest.fn(() => Promise.resolve(true)),
}));

// Mock GlassBackground to avoid Animated.timing issues in tests
jest.mock('../src/components/GlassBackground', () => {
  const { View } = require('react-native');
  return {
    GlassBackground: () => <View testID="mock-glass-background" />,
  };
});

// Mock react-native-webview using manual mock to avoid native module errors in Jest environment
jest.mock('react-native-webview');

// Mock react-native-image-crop-picker to avoid native module errors in Jest environment
jest.mock('react-native-image-crop-picker', () => ({
  __esModule: true,
  default: {
    openPicker: jest.fn(),
    openCamera: jest.fn(),
    openCropper: jest.fn(),
  },
}));

// Mock WatermelonDB SQLite adapter to avoid native module errors
jest.mock('@nozbe/watermelondb/adapters/sqlite', () => {
  return jest.fn().mockImplementation(() => ({
    batch: jest.fn(),
    // Provide a mocked schema to prevent Database constructor from crashing
    schema: {
      tables: {
        playlist_meta: { name: 'playlist_meta', columns: [] },
        video_meta: { name: 'video_meta', columns: [] },
        sync_job: { name: 'sync_job', columns: [] },
      },
    },
  }));
});

import App from '../App';

// Note: import explicitly to use the types shipped with jest.
import {it} from '@jest/globals';

// Note: test renderer must be required after react-native.
import renderer from 'react-test-renderer';

it('renders correctly', () => {
  renderer.create(<App />);
});
