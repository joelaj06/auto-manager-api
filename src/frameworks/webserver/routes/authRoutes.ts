import express from "express";
import { AuthController } from "../../../adapters/controllers/authController";
import { AuthInteractorImpl } from "../../../application/interactors/authInteractorImpl";
import { AuthRepositoryImpl } from "../../database/mongodb/repositories/authRepositoryImpl";
import { AuthServiceImpl } from "../../services/authService";

const repository = new AuthRepositoryImpl();
const authService = new AuthServiceImpl();
const interactor = new AuthInteractorImpl(repository, authService);
const controller = new AuthController(interactor);

const router = express.Router();

router.post("/api/auth/register", controller.registerUser.bind(controller));
router.get("/api/test", controller.test.bind(controller));

export default router;
