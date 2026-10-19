import {
  Supplier,
  type SupplierDetails,
  type SupplierProps,
} from "../../../domain/parties/Supplier.js";
import type { ISupplierRepository } from "../../../domain/repositories/IPartyRepositories.js";
import type { Principal } from "../../authorization/Principal.js";
import { PartyExistsError, SupplierNotFoundError } from "../../errors/PartyErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ISupplierQueries, SupplierListFilter } from "../../ports/IPartyRecords.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";

export type SupplierView = Omit<SupplierProps, "deletedAt" | "deletedReason">;

const EMPTY: SupplierDetails = Object.freeze({
  name: "",
  type: "other",
  contactPerson: null,
  phone: null,
  email: null,
  address: null,
  tin: null,
  paymentTermsDays: null,
  payout: null,
  active: true,
  tags: [],
  notes: null,
});

const view = ({ deletedAt: _d, deletedReason: _r, ...rest }: SupplierProps): SupplierView => rest;

/**
 * Suppliers (docs/05 §2.2): who the business buys vehicles, parts, fuel, repairs and cover
 * from; shared by every branch. Deactivate a supplier to stop offering it; remove only
 * mistaken entries.
 */
export class SupplierAdministration {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      suppliers: ISupplierRepository;
      queries: ISupplierQueries;
      numbering: DocumentNumbering;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async list(filter: SupplierListFilter): Promise<SupplierView[]> {
    return (await this.deps.unitOfWork.run(() => this.deps.queries.list(filter))).map(view);
  }

  async get(id: string): Promise<SupplierView> {
    return this.deps.unitOfWork.run(async () => view((await this.find(id)).snapshot()));
  }

  async create(actor: Principal, input: Partial<SupplierDetails>): Promise<SupplierView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      const supplier = Supplier.create({
        id: deps.ids.next(),
        code: await deps.numbering.next("supplier", now),
        details: { ...EMPTY, ...withoutUndefined(input) },
        createdBy: actor.userId,
        now,
      });
      await this.assertUnique(supplier);
      await deps.suppliers.save(supplier);
      await recordUserAction(deps, actor.userId, {
        action: "supplier.created",
        entityType: "supplier",
        entityId: supplier.id,
        after: supplier.snapshot(),
      });
      return view(supplier.snapshot());
    });
  }

  async update(
    actor: Principal,
    id: string,
    changes: Partial<SupplierDetails>,
  ): Promise<SupplierView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const supplier = await this.find(id, true);
      const before = supplier.snapshot();
      supplier.update(withoutUndefined(changes), deps.clock.now());
      await this.assertUnique(supplier);
      await deps.suppliers.save(supplier);
      await recordUserAction(deps, actor.userId, {
        action: "supplier.updated",
        entityType: "supplier",
        entityId: id,
        before,
        after: supplier.snapshot(),
      });
      return view(supplier.snapshot());
    });
  }

  async remove(actor: Principal, id: string, reason: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const supplier = await this.find(id, true);
      supplier.remove(reason, deps.clock.now());
      await deps.suppliers.save(supplier);
      await recordUserAction(deps, actor.userId, {
        action: "supplier.removed",
        entityType: "supplier",
        entityId: id,
        before: { code: supplier.snapshot().code, name: supplier.snapshot().name },
        metadata: { reason },
      });
    });
  }

  private async find(id: string, lock = false): Promise<Supplier> {
    const supplier = lock
      ? await this.deps.suppliers.lockById(id)
      : await this.deps.suppliers.findById(id);
    if (supplier === null) throw new SupplierNotFoundError();
    return supplier;
  }

  private async assertUnique(supplier: Supplier): Promise<void> {
    const { id, name } = supplier.snapshot();
    if (await this.deps.suppliers.nameTaken(name, id))
      throw new PartyExistsError(`A supplier named ${name} already exists`);
  }
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
