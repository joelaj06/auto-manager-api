import express from "express";
import { AuthController } from "../../../adapters/controllers/authController";
import { AuthInteractor } from "../../../application/interactors/authInteractor";

const interactor = new AuthInteractor();
const controller = new AuthController(interactor);

const router = express.Router();

router.get("/test", controller.test.bind(controller));

export default router;
