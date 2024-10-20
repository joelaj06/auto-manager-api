export interface IStorageBucket {
  uploadImage(base64String: string): Promise<string>;
  configureStorageBucket(): Promise<void>;
}
