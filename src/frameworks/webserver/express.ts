//handle express configs here
import cors from "cors";
import express, { Express } from "express";

export default function expressConfig(app: Express) {
  //set up express middlewares here

  // Enable CORS for all requests
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
}
