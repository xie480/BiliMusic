import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

export type NetType = 'wifi' | 'cellular' | 'none' | 'unknown';

class NetStatus {
  private _type: NetType = 'unknown';
  private listeners = new Set<(t: NetType) => void>();

  init() {
    NetInfo.addEventListener((s: NetInfoState) => {
      const t: NetType = !s.isConnected
        ? 'none'
        : s.type === 'wifi'
        ? 'wifi'
        : s.type === 'cellular'
        ? 'cellular'
        : 'unknown';
      if (t !== this._type) {
        this._type = t;
        this.listeners.forEach((fn) => fn(t));
      }
    });
  }

  get type() {
    return this._type;
  }
  isWifi = () => this._type === 'wifi';
  isCellular = () => this._type === 'cellular';
  onChange(fn: (t: NetType) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const netStatus = new NetStatus();
