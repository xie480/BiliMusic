import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, StyleProp, TextStyle, ViewStyle, ScrollView } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withDelay,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';

interface MarqueeTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  delay?: number;
  speed?: number; // pixels per second
}

export const MarqueeText: React.FC<MarqueeTextProps> = ({
  text,
  style,
  containerStyle,
  delay = 2000,
  speed = 30,
}) => {
  const [containerWidth, setContainerWidth] = useState(0);
  const [fullTextWidth, setFullTextWidth] = useState(0);
  const translateX = useSharedValue(0);

  useEffect(() => {
    if (fullTextWidth > containerWidth && containerWidth > 0) {
      const distance = fullTextWidth - containerWidth + 20; // 20px extra scroll
      const duration = (distance / speed) * 1000;

      translateX.value = 0;
      translateX.value = withDelay(
        delay,
        withRepeat(
          withTiming(-distance, {
            duration: duration,
            easing: Easing.linear,
          }),
          -1,
          true // reverse
        )
      );
    } else {
      cancelAnimation(translateX);
      translateX.value = 0;
    }
    return () => cancelAnimation(translateX);
  }, [fullTextWidth, containerWidth, text, delay, speed, translateX]);

  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateX: translateX.value }],
    };
  });

  return (
    <View style={[styles.container, containerStyle]} onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}>
      <ScrollView
        horizontal
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        bounces={false}
        contentContainerStyle={{ flexDirection: 'row' }}
      >
        <Animated.View style={[styles.textContainer, animatedStyle]}>
          <Text
            style={[style, { flexShrink: 0 }]}
            numberOfLines={1}
            ellipsizeMode="clip"
            onLayout={(e) => setFullTextWidth(e.nativeEvent.layout.width)}
          >
            {text}
          </Text>
        </Animated.View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    width: '100%',
  },
  textContainer: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
  },
});
