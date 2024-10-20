//handle express configs here

import express, { Express } from "express";

export default function expressConfig(app: Express | any) {
  //set up express middlewares here
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true }));
}
