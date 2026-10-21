import { listOf, type FieldSchema } from "./TemplateEngine.js";
import { TRANSFER_LETTER_V1 } from "./templates/transferLetter.js";
import { VEHICLE_HANDOVER_V1 } from "./templates/vehicleHandover.js";
import { WORKPAY_AGREEMENT_V2 } from "./templates/workPayAgreement.js";

export const DOCUMENT_TYPES = ["vehicle_handover", "workpay_agreement", "transfer_letter"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const LANGUAGES = ["en"] as const;
export type Language = (typeof LANGUAGES)[number];

export type DocumentTypeDefinition = Readonly<{
  name: string;
  /** Numbering kind (DocumentNumbering) of issued documents. */
  numbering: string;
  /** What a document of this type is about. */
  subjectType: string;
  /** Fields its templates may use. */
  fields: FieldSchema;
  /** The template every business starts from (its locked clauses bind their own versions). */
  system: Readonly<{ version: number; body: string }>;
  /** Realistic data for previews of a template. */
  sample: Readonly<Record<string, unknown>>;
}>;

const money = (amountMinor: number) => ({ amountMinor, currency: "GHS" });

const ISSUER: FieldSchema = {
  name: "text",
  tin: "text",
  phone: "text",
  email: "text",
  address: "text",
};
const DOCUMENT: FieldSchema = { number: "text", issuedOn: "date" };
const VEHICLE: FieldSchema = {
  code: "text",
  plateNumber: "text",
  make: "text",
  model: "text",
  year: "number",
  colour: "text",
  vin: "text",
  engineNumber: "text",
};
const DRIVER: FieldSchema = {
  code: "text",
  name: "text",
  phone: "text",
  address: "text",
  ghanaCardNumber: "text",
  licenceNumber: "text",
};

const SAMPLE_ISSUER = {
  name: "Accra Fleet Services Ltd",
  tin: "C0001234567",
  phone: "+233 24 000 0000",
  email: "office@accrafleet.com",
  address: "12 Ring Road, Accra",
};
const SAMPLE_VEHICLE = {
  code: "VEH-00012",
  plateNumber: "GR 4321-26",
  make: "Toyota",
  model: "Corolla",
  year: 2019,
  colour: "Silver",
  vin: "JTDBR32E720123456",
  engineNumber: "1ZZ-4567890",
};
const SAMPLE_DRIVER = {
  code: "DRV-00007",
  name: "Kwame Mensah",
  phone: "+233 24 123 4567",
  address: "House 5, Madina, Accra",
  ghanaCardNumber: "GHA-123456789-1",
  licenceNumber: "DL-778899",
};

/**
 * The documents the system issues from templates (docs/24 §1). Each type's data is snapshotted
 * when a document is issued; its templates are checked against `fields`.
 */
export const DOCUMENT_TYPE_CATALOG: Readonly<Record<DocumentType, DocumentTypeDefinition>> =
  Object.freeze({
    vehicle_handover: {
      name: "Vehicle handover",
      numbering: "handover_document",
      subjectType: "vehicle_assignment",
      fields: {
        issuer: ISSUER,
        document: DOCUMENT,
        vehicle: VEHICLE,
        driver: DRIVER,
        handover: { startedAt: "date", odometer: "number", unit: "text", branch: "text" },
        terms: { mode: "text", target: "money", frequency: "text", daysOff: "text" },
        checklist: listOf({ label: "text", ok: "boolean", note: "text" }),
      },
      system: { version: 1, body: VEHICLE_HANDOVER_V1 },
      sample: {
        issuer: SAMPLE_ISSUER,
        document: { number: "HND-2026-000001", issuedOn: "2026-10-21" },
        vehicle: SAMPLE_VEHICLE,
        driver: SAMPLE_DRIVER,
        handover: { startedAt: "2026-10-21", odometer: 84_210, unit: "km", branch: "Accra" },
        terms: {
          mode: "Fixed target",
          target: money(25_000),
          frequency: "daily",
          daysOff: "Sunday",
        },
        checklist: [
          { label: "Spare tyre", ok: true, note: null },
          { label: "Jack and wheel spanner", ok: true, note: null },
          { label: "Fire extinguisher", ok: false, note: "Missing; to be supplied" },
        ],
      },
    },
    workpay_agreement: {
      name: "Work and pay agreement",
      numbering: "workpay_document",
      subjectType: "workpay_agreement",
      fields: {
        issuer: ISSUER,
        document: DOCUMENT,
        vehicle: VEHICLE,
        driver: DRIVER,
        agreement: {
          number: "text",
          startDate: "date",
          price: "money",
          deposit: "money",
          financed: "money",
          instalment: "money",
          instalments: "number",
          frequency: "text",
          firstDueOn: "date",
          lastDueOn: "date",
          graceDays: "number",
          maintenance: "text",
          insurance: "text",
        },
        schedule: listOf({ number: "number", dueOn: "date", amount: "money" }),
        guarantors: listOf({ name: "text", phone: "text", relationship: "text" }),
      },
      system: { version: 2, body: WORKPAY_AGREEMENT_V2 },
      sample: {
        issuer: SAMPLE_ISSUER,
        document: { number: "WPA-2026-000001", issuedOn: "2026-10-21" },
        vehicle: SAMPLE_VEHICLE,
        driver: SAMPLE_DRIVER,
        agreement: {
          number: "WP-2026-000003",
          startDate: "2026-11-01",
          price: money(9_000_000),
          deposit: money(1_000_000),
          financed: money(8_000_000),
          instalment: money(200_000),
          instalments: 40,
          frequency: "weekly",
          firstDueOn: "2026-11-08",
          lastDueOn: "2027-08-08",
          graceDays: 3,
          maintenance: "the driver",
          insurance: "the owner",
        },
        schedule: [
          { number: 1, dueOn: "2026-11-08", amount: money(200_000) },
          { number: 2, dueOn: "2026-11-15", amount: money(200_000) },
          { number: 3, dueOn: "2026-11-22", amount: money(200_000) },
        ],
        guarantors: [{ name: "Yaw Boateng", phone: "+233 20 555 0101", relationship: "Brother" }],
      },
    },
    transfer_letter: {
      name: "Transfer letter of agreement",
      numbering: "transfer_document",
      subjectType: "workpay_agreement",
      fields: {
        issuer: ISSUER,
        document: DOCUMENT,
        vehicle: VEHICLE,
        driver: DRIVER,
        agreement: {
          number: "text",
          startDate: "date",
          totalPaid: "money",
          finalPaymentOn: "date",
        },
        transfer: { odometer: "number", unit: "text", condition: "text" },
        handedOver: listOf({ item: "text", included: "boolean" }),
      },
      system: { version: 1, body: TRANSFER_LETTER_V1 },
      sample: {
        issuer: SAMPLE_ISSUER,
        document: { number: "TRL-2026-000001", issuedOn: "2026-10-21" },
        vehicle: SAMPLE_VEHICLE,
        driver: SAMPLE_DRIVER,
        agreement: {
          number: "WP-2025-000001",
          startDate: "2025-01-06",
          totalPaid: money(9_000_000),
          finalPaymentOn: "2026-10-14",
        },
        transfer: { odometer: 152_400, unit: "km", condition: "Used, roadworthy" },
        handedOver: [
          { item: "Registration documents", included: true },
          { item: "Insurance certificate", included: true },
          { item: "Spare key", included: false },
        ],
      },
    },
  });

export function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(value);
}
