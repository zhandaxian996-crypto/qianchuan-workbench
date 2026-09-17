import React from 'react';
import {Composition} from 'remotion';
import {QianchuanOpenSource} from './Video';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="QianchuanOpenSource"
      component={QianchuanOpenSource}
      durationInFrames={1800}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{}}
    />
  );
};
