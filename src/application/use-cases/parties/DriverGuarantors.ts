import {
  InvalidPartyError,
  maskGhanaCard,
  optionalText,
  parseGhanaCard,
  requiredText,
} from "../../../domain/parties/PartyDetails.js";
import { PhoneNumber } from "../../../domain/value-objects/PhoneNumber.js";
import type { Principal } from "../../authorization/Principal.js";
import { GuarantorNotFoundError } from "../../errors/PartyErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { Guarantor, IDriverGuarantors } from "../../ports/IPartyRecords.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { DriverAdministration } from "./DriverAdministration.js";

export type GuarantorInput = Readonly<{
  name?: string;
  phone?: string;
  relationship?: string | null;
  address?: string | null;
  occupation?: string | null;
  ghanaCardNumber?: string | null;
}>;

const MAX_GUARANTORS = 5;

/**
 * A driver's guarantors (docs/09 §4): the people who answer for the driver (and for a
 * work-and-pay balance). Their identity documents are party documents of the guarantor.
 */
export class DriverGuarantors {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      drivers: DriverAdministration;
      guarantors: IDriverGuarantors;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async add(actor: Principal, driverId: string, input: GuarantorInput): Promise<Guarantor> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.drivers.reach(actor, driverId, "drivers.update", true);
      if ((await deps.guarantors.list(driverId)).length >= MAX_GUARANTORS)
        throw new InvalidPartyError(`A driver has at most ${MAX_GUARANTORS} guarantors`);
      const now = deps.clock.now();
      const guarantor = checked({
        id: deps.ids.next(),
        driverId,
        name: input.name ?? "",
        phone: input.phone ?? "",
        relationship: input.relationship ?? null,
        address: input.address ?? null,
        occupation: input.occupation ?? null,
        ghanaCardNumber: input.ghanaCardNumber ?? null,
        createdAt: now,
        updatedAt: now,
      });
      await deps.guarantors.save(guarantor);
      await this.audit(actor, driverId, "driver.guarantor_added", undefined, guarantor);
      return guarantor;
    });
  }

  async update(
    actor: Principal,
    driverId: string,
    guarantorId: string,
    input: GuarantorInput,
  ): Promise<Guarantor> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await this.reach(actor, driverId, guarantorId, "drivers.update");
      const after = checked({
        ...before,
        ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
        updatedAt: deps.clock.now(),
      });
      await deps.guarantors.save(after);
      await this.audit(actor, driverId, "driver.guarantor_updated", before, after);
      return after;
    });
  }

  async remove(actor: Principal, driverId: string, guarantorId: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const guarantor = await this.reach(actor, driverId, guarantorId, "drivers.update");
      await deps.guarantors.remove(guarantorId);
      await this.audit(actor, driverId, "driver.guarantor_removed", guarantor, undefined);
    });
  }

  /** The guarantor of a driver within the caller's branches (call inside a unit of work). */
  async reach(
    actor: Principal,
    driverId: string,
    guarantorId: string,
    permission: "drivers.view" | "drivers.update" | "drivers.documents.view",
  ): Promise<Guarantor> {
    await this.deps.drivers.reach(actor, driverId, permission);
    const guarantor = await this.deps.guarantors.get(guarantorId);
    if (guarantor?.driverId !== driverId) throw new GuarantorNotFoundError();
    return guarantor;
  }

  private async audit(
    actor: Principal,
    driverId: string,
    action: string,
    before: Guarantor | undefined,
    after: Guarantor | undefined,
  ): Promise<void> {
    const mask = (g: Guarantor | undefined) =>
      g === undefined || g.ghanaCardNumber === null
        ? g
        : { ...g, ghanaCardNumber: maskGhanaCard(g.ghanaCardNumber) };
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "driver",
      entityId: driverId,
      before: mask(before),
      after: mask(after),
    });
  }
}

function checked(g: Guarantor): Guarantor {
  return {
    ...g,
    name: requiredText(g.name, "Guarantor name", 120),
    phone: PhoneNumber.parse(g.phone).value,
    relationship: optionalText(g.relationship, "Relationship", 60),
    address: optionalText(g.address, "Address", 300),
    occupation: optionalText(g.occupation, "Occupation", 80),
    ghanaCardNumber: g.ghanaCardNumber === null ? null : parseGhanaCard(g.ghanaCardNumber),
  };
}
