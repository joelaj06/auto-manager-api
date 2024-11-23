//data base connection
import { ConnectOptions, Mongoose } from "mongoose";
import { IConfig } from "../../../config/IConfig";
export default function connection(mongoose: Mongoose, config: IConfig) {
  function connectToMongo() {
    mongoose
      .connect(config.mongo.uri)
      .then(
        () => {},
        (err) => {
          console.info("Mongodb error", err);
        }
      )
      .catch((err) => {
        console.log("ERROR:", err);
      });
  }

  mongoose.connection.on("connected", () => {
    console.info("Connected to MongoDB! 🗄️ ✅");
  });

  mongoose.connection.on("reconnected", () => {
    console.info("MongoDB reconnected!🗄️ ✅");
  });

  mongoose.connection.on("error", (error) => {
    console.error(`Error in MongoDb connection: ${error}`);
    mongoose.disconnect();
  });

  mongoose.connection.on("disconnected", () => {
    console.info("MongoDB disconnected!🗄️❌");
  });

  return {
    connectToMongo,
  };
}
