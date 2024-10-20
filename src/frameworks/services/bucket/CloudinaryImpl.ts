import { injectable } from "inversify";
import { IStorageBucket } from "./IStorageBucket";
import { v2 as cloudinary } from "cloudinary";
import config from "../../../config/config";

@injectable()
export class CloudinaryImpl implements IStorageBucket {
  async uploadImage(base64String: string): Promise<string> {
    try {
      const uploadStr = "data:image/jpeg;base64," + base64String;
      const imageRes = await cloudinary.uploader.upload(uploadStr, {
        upload_preset: "bookme",
      });
      return imageRes.secure_url;
    } catch (error) {
      throw error;
    }
  }
  async configureStorageBucket(): Promise<void> {
    try {
      cloudinary.config({
        cloud_name: config.cloudinaryCloudName,
        api_key: config.cloudinaryApiKey,
        api_secret: config.cloudinaryApiSecrete,
      });
      console.log("Cloudinary configured successfully");
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
}
