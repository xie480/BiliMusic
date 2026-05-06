module.exports = {
 presets: ['module:@react-native/babel-preset'],
 plugins: [
   ['@babel/plugin-proposal-decorators', { legacy: true }],
   [
     'module-resolver',
     {
       root: ['./src'],
       extensions: ['.ios.js', '.android.js', '.js', '.ts', '.tsx', '.json'],
       alias: {
         '@': './src',
       },
     },
   ],
   'react-native-reanimated/plugin',
 ],
};
