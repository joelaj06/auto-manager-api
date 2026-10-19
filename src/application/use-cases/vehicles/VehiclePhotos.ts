import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IClock } from "../../ports/IClock.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import type { VehicleAccess } from "./VehicleAccess.js";

export type VehiclePhotoView = FileView & Readonly<{ primary: boolean }>;

/**
 * Vehicle photos (docs/06 §2 media): a gallery of uploaded images, one of them the primary photo
 * (the first photo becomes primary; removing it promotes the next newest).
 */
export class VehiclePhotos {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      vehicles: IVehicleRepository;
      access: VehicleAccess;
      photos: OwnedDocuments;
      clock: IClock;
    }>,
  ) {}

  async list(actor: Principal, vehicleId: string): Promise<VehiclePhotoView[]> {
    const vehicle = await this.deps.unitOfWork.run(() =>
      this.deps.access.reach(actor, vehicleId, "vehicles.view"),
    );
    const primary = vehicle.snapshot().primaryPhotoFileId;
    return (await this.deps.photos.list(vehicleId)).map((p) => ({
      ...p,
      primary: p.id === primary,
    }));
  }

  /** The primary photo with its (short-lived) URL, if any. */
  async primary(vehicleId: string, fileId: string | null): Promise<FileView | null> {
    if (fileId === null) return null;
    return this.deps.photos.get(vehicleId, fileId).catch(() => null);
  }

  async start(
    actor: Principal,
    vehicleId: string,
    input: DocumentUploadInput,
  ): Promise<UploadStarted> {
    await this.deps.unitOfWork.run(() =>
      this.deps.access.reach(actor, vehicleId, "vehicles.photos.manage"),
    );
    return this.deps.photos.start(vehicleId, input, actor.userId);
  }

  async complete(actor: Principal, vehicleId: string, fileId: string): Promise<VehiclePhotoView> {
    const { deps } = this;
    await deps.unitOfWork.run(() => deps.access.reach(actor, vehicleId, "vehicles.photos.manage"));
    // Confirmed on its own: a rejected file must stay deleted whatever happens next.
    const file = await deps.photos.complete(vehicleId, fileId);
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.access.reach(actor, vehicleId, "vehicles.photos.manage", true);
      if (vehicle.snapshot().primaryPhotoFileId === null) {
        vehicle.setPrimaryPhoto(file.id, deps.clock.now());
        await deps.vehicles.save(vehicle);
      }
      return { ...file, primary: vehicle.snapshot().primaryPhotoFileId === file.id };
    });
  }

  async setPrimary(actor: Principal, vehicleId: string, fileId: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const vehicle = await deps.access.reach(actor, vehicleId, "vehicles.photos.manage", true);
      const file = await deps.photos.get(vehicleId, fileId);
      vehicle.setPrimaryPhoto(file.id, deps.clock.now());
      await deps.vehicles.save(vehicle);
    });
  }

  async remove(actor: Principal, vehicleId: string, fileId: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const vehicle = await deps.access.reach(actor, vehicleId, "vehicles.photos.manage", true);
      await deps.photos.remove(vehicleId, fileId);
      if (vehicle.snapshot().primaryPhotoFileId === fileId) {
        const next = (await deps.photos.list(vehicleId)).find((p) => p.id !== fileId);
        vehicle.setPrimaryPhoto(next?.id ?? null, deps.clock.now());
        await deps.vehicles.save(vehicle);
      }
    });
  }
}
