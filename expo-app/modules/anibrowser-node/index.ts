import { requireNativeModule } from 'expo-modules-core';

type AniBrowserNodeModule = {
  /** Extract the bundled project zip, boot node, resolve with the bound port. */
  startNode(zipPath: string, dataDir: string): Promise<number>;
  moveTaskToBack(): boolean;
  /** Report whether a <video> is playing (drives picture-in-picture on home). */
  setVideoActive(active: boolean): boolean;
  /** Dock the current video into picture-in-picture. */
  enterPip(): boolean;
  /** Post a system notification (favorites update). Requests POST_NOTIFICATIONS first on API 33+. */
  notify(title: string, body: string): boolean;
  /** Hand a downloaded APK file to the system package installer. */
  installApk(path: string): Promise<boolean>;
  /** Copy the APK into public Downloads (API 29+) and open the Downloads list. */
  openUpdatesDir(path: string): Promise<boolean>;
};

export default requireNativeModule('AniBrowserNode') as AniBrowserNodeModule;