import authRoutes from "./authRoutes";
import userRoutes from "./userRoutes";
import companyRoutes from "./companyRoutes";
import vehicleRoutes from "./vehicleRoutes";
import driverRoutes from "./driverRoutes";
import saleRoutes from "./saleRoutes";
import expenseRoutes from "./expenseRoutes";
import rentalRoutes from "./rentalRoutes";
import customerRoutes from "./customerRoutes";
import dashboardRoutes from "./dashboardRoutes";
import roleRoutes from "./roleRoutes";
import permissionRoutes from "./permissionRoutes";
import workAndPayRoutes from "./workandpayRoutes";
import express from "express";

const router = express.Router();

router.use(authRoutes);
router.use(userRoutes);
router.use(companyRoutes);
router.use(vehicleRoutes);
router.use(driverRoutes);
router.use(saleRoutes);
router.use(expenseRoutes);
router.use(rentalRoutes);
router.use(customerRoutes);
router.use(dashboardRoutes);
router.use(roleRoutes);
router.use(permissionRoutes);
router.use(workAndPayRoutes);

export default router;
