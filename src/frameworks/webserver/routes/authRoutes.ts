import express from "express";
import { AuthController } from "../../../adapters/controllers/authController";
import { AuthInteractorImpl } from "../../../application/interactors/authInteractorImpl";
import { AuthRepositoryImpl } from "../../database/mongodb/repositories/authRepositoryImpl";

const repository = new AuthRepositoryImpl();
const interactor = new AuthInteractorImpl(repository);
const controller = new AuthController(interactor);

const router = express.Router();

router.post("/api/auth/register", controller.registerUser.bind(controller));
router.get("/api/test", controller.test.bind(controller));

export default router;
