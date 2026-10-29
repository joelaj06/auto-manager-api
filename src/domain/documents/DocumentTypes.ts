import { listOf, type FieldSchema } from "./TemplateEngine.js";
import { DEALER_DELIVERY_NOTE_V1 } from "./templates/dealerDeliveryNote.js";
import { DEALER_QUOTE_V1 } from "./templates/dealerQuote.js";
import { DEALER_SALES_AGREEMENT_V1 } from "./templates/dealerSalesAgreement.js";
import { RENTAL_AGREEMENT_V1 } from "./templates/rentalAgreement.js";
import { RENTAL_RETURN_V1 } from "./templates/rentalReturn.js";
import { TEST_DRIVE_WAIVER_V1 } from "./templates/testDriveWaiver.js";
import { TRANSFER_LETTER_V1 } from "./templates/transferLetter.js";
import { VEHICLE_HANDOVER_V1 } from "./templates/vehicleHandover.js";
import { WORKPAY_AGREEMENT_V3 } from "./templates/workPayAgreement.js";

export const DOCUMENT_TYPES = [
  "vehicle_handover",
  "workpay_agreement",
  "transfer_letter",
  "rental_agreement",
  "rental_return",
  "dealer_quote",
  "test_drive_waiver",
  "dealer_sales_agreement",
  "dealer_delivery_note",
] as const;
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

const RENTER: FieldSchema = {
  code: "text",
  name: "text",
  phone: "text",
  email: "text",
  address: "text",
};
const RENTAL_DRIVER: FieldSchema = {
  name: "text",
  phone: "text",
  ghanaCardNumber: "text",
  licenceNumber: "text",
  licenceExpiresOn: "date",
};
const CHECKLIST = listOf({ label: "text", ok: "boolean", note: "text" });
const CHARGES = listOf({ description: "text", amount: "money" });
const CHARGES_OF = (description: string, amount: string) =>
  listOf({ [description]: "text", [amount]: "money" });

const SAMPLE_RENTER = {
  code: "CUS-00042",
  name: "Abena Owusu",
  phone: "+233 20 765 4321",
  email: "abena@example.com",
  address: "14 Spintex Road, Accra",
};
const SAMPLE_RENTAL_DRIVER = {
  name: "Abena Owusu",
  phone: "+233 20 765 4321",
  ghanaCardNumber: "GHA-987654321-0",
  licenceNumber: "DL-445566",
  licenceExpiresOn: "2029-05-31",
};
const SAMPLE_CHECKLIST = [
  { label: "Spare tyre", ok: true, note: null },
  { label: "Warning triangle", ok: true, note: null },
  { label: "Clean inside and out", ok: false, note: "Mud on the rear mats" },
];

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
          lateFee: "text",
          maintenance: "text",
          insurance: "text",
        },
        schedule: listOf({ number: "number", dueOn: "date", amount: "money" }),
        guarantors: listOf({ name: "text", phone: "text", relationship: "text" }),
      },
      system: { version: 3, body: WORKPAY_AGREEMENT_V3 },
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
          lateFee: "A late fee of ₵50.00 is charged once on each overdue instalment",
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
    rental_agreement: {
      name: "Vehicle rental agreement",
      numbering: "rental_agreement_document",
      subjectType: "rental_booking",
      fields: {
        issuer: ISSUER,
        document: DOCUMENT,
        vehicle: VEHICLE,
        renter: RENTER,
        driver: RENTAL_DRIVER,
        rental: {
          number: "text",
          branch: "text",
          pickupOn: "date",
          pickupTime: "text",
          returnOn: "date",
          returnTime: "text",
          plan: "text",
          mileage: "text",
          odometer: "number",
          unit: "text",
          fuel: "text",
          deposit: "money",
          total: "money",
          signatory: "text",
        },
        charges: CHARGES,
        checklist: CHECKLIST,
        damages: listOf({ area: "text", severity: "text", description: "text" }),
      },
      system: { version: 1, body: RENTAL_AGREEMENT_V1 },
      sample: {
        issuer: SAMPLE_ISSUER,
        document: { number: "RAG-2027-000001", issuedOn: "2027-04-10" },
        vehicle: SAMPLE_VEHICLE,
        renter: SAMPLE_RENTER,
        driver: SAMPLE_RENTAL_DRIVER,
        rental: {
          number: "RNT-2027-000014",
          branch: "Accra",
          pickupOn: "2027-04-10",
          pickupTime: "09:00",
          returnOn: "2027-04-13",
          returnTime: "09:00",
          plan: "Saloon standard",
          mileage: "100 km a day included, then GHS 2.00 a km",
          odometer: 84_210,
          unit: "km",
          fuel: "full",
          deposit: money(50_000),
          total: money(90_000),
          signatory: "Abena Owusu",
        },
        charges: [{ description: "Rental", amount: money(90_000) }],
        checklist: SAMPLE_CHECKLIST,
        damages: [{ area: "front", severity: "minor", description: "Scratch on the bumper" }],
      },
    },
    rental_return: {
      name: "Vehicle return",
      numbering: "rental_return_document",
      subjectType: "rental_booking",
      fields: {
        issuer: ISSUER,
        document: DOCUMENT,
        vehicle: VEHICLE,
        renter: RENTER,
        driver: RENTAL_DRIVER,
        rental: {
          number: "text",
          agreementNumber: "text",
          branch: "text",
          returnedOn: "date",
          returnedTime: "text",
          dueOn: "date",
          dueTime: "text",
          odometerOut: "number",
          odometerIn: "number",
          km: "number",
          unit: "text",
          fuelOut: "text",
          fuelIn: "text",
          total: "money",
          signatory: "text",
        },
        checklist: CHECKLIST,
        damages: listOf({
          area: "text",
          severity: "text",
          description: "text",
          estimate: "money",
        }),
        charges: CHARGES,
      },
      system: { version: 1, body: RENTAL_RETURN_V1 },
      sample: {
        issuer: SAMPLE_ISSUER,
        document: { number: "RRN-2027-000001", issuedOn: "2027-04-13" },
        vehicle: SAMPLE_VEHICLE,
        renter: SAMPLE_RENTER,
        driver: SAMPLE_RENTAL_DRIVER,
        rental: {
          number: "RNT-2027-000014",
          agreementNumber: "RAG-2027-000001",
          branch: "Accra",
          returnedOn: "2027-04-13",
          returnedTime: "11:30",
          dueOn: "2027-04-13",
          dueTime: "09:00",
          odometerOut: 84_210,
          odometerIn: 84_650,
          km: 440,
          unit: "km",
          fuelOut: "full",
          fuelIn: "half",
          total: money(124_000),
          signatory: "Abena Owusu",
        },
        checklist: SAMPLE_CHECKLIST,
        damages: [
          {
            area: "left",
            severity: "moderate",
            description: "Dent in the rear door",
            estimate: money(85_000),
          },
        ],
        charges: [
          { description: "Late return (150 minutes)", amount: money(15_000) },
          { description: "Refuelling (2 quarter tanks)", amount: money(10_000) },
        ],
      },
    },
    dealer_quote: {
      name: "Sales quotation",
      numbering: "quote_document",
      subjectType: "dealer_quote",
      fields: {
        issuer: ISSUER,
        document: DOCUMENT,
        vehicle: { ...VEHICLE, odometer: "number" },
        customer: { name: "text", phone: "text" },
        quote: {
          number: "text",
          validUntil: "date",
          currency: "text",
          price: "money",
          hasDiscount: "boolean",
          discount: "money",
          total: "money",
          tradeIn: "text",
          tradeInValue: "money",
          balance: "money",
          financing: "text",
          deposit: "money",
          termMonths: "number",
          financingNote: "text",
          notes: "text",
        },
        addOns: CHARGES_OF("description", "amount"),
      },
      system: { version: 1, body: DEALER_QUOTE_V1 },
      sample: {
        issuer: SAMPLE_ISSUER,
        document: { number: "QTD-2026-000001", issuedOn: "2026-10-29" },
        vehicle: { ...SAMPLE_VEHICLE, odometer: 64_200 },
        customer: { name: "Yaw Mensah", phone: "+233 24 555 0101" },
        quote: {
          number: "QUO-2026-000007",
          validUntil: "2026-11-12",
          currency: "GHS",
          price: money(15_500_000),
          hasDiscount: true,
          discount: money(500_000),
          total: money(15_350_000),
          tradeIn: "Honda Civic 2012, GT 1234-12",
          tradeInValue: money(4_000_000),
          balance: money(11_350_000),
          financing: "Bank loan",
          deposit: money(3_000_000),
          termMonths: 24,
          financingNote: "Subject to the bank's approval",
          notes: null,
        },
        addOns: [
          { description: "Registration and number plates", amount: money(150_000) },
          { description: "Tracker", amount: money(200_000) },
        ],
      },
    },
    test_drive_waiver: {
      name: "Test drive waiver",
      numbering: "test_drive_document",
      subjectType: "dealer_test_drive",
      fields: {
        issuer: ISSUER,
        document: DOCUMENT,
        vehicle: VEHICLE,
        driver: { name: "text", phone: "text", licenceNumber: "text", licenceExpiresOn: "date" },
        drive: { startsAt: "text", endsAt: "text", accompaniedBy: "text", odometerOut: "number" },
      },
      system: { version: 1, body: TEST_DRIVE_WAIVER_V1 },
      sample: {
        issuer: SAMPLE_ISSUER,
        document: { number: "TDW-2026-000001", issuedOn: "2026-10-29" },
        vehicle: SAMPLE_VEHICLE,
        driver: {
          name: "Yaw Mensah",
          phone: "+233 24 555 0101",
          licenceNumber: "DL-112233",
          licenceExpiresOn: "2029-01-31",
        },
        drive: {
          startsAt: "29 Oct 2026, 10:00",
          endsAt: "29 Oct 2026, 10:45",
          accompaniedBy: "Esi Boateng",
          odometerOut: 64_200,
        },
      },
    },
    dealer_sales_agreement: {
      name: "Vehicle sales agreement",
      numbering: "sales_agreement_document",
      subjectType: "dealer_deal",
      fields: {
        issuer: ISSUER,
        document: DOCUMENT,
        vehicle: { ...VEHICLE, odometer: "number" },
        buyer: { name: "text", phone: "text", address: "text", ghanaCardNumber: "text" },
        deal: {
          number: "text",
          price: "money",
          hasDiscount: "boolean",
          discount: "money",
          invoiceNumber: "text",
          invoiced: "money",
          tradeIn: "text",
          tradeInValue: "money",
          financing: "text",
          lender: "text",
          loan: "money",
          hasPlan: "boolean",
          downPayment: "money",
          instalments: "number",
          instalment: "money",
          firstDueOn: "date",
          lastDueOn: "date",
          planCharge: "money",
          warrantyMonths: "number",
          serviceVouchers: "number",
          notes: "text",
        },
        addOns: CHARGES_OF("description", "amount"),
      },
      system: { version: 1, body: DEALER_SALES_AGREEMENT_V1 },
      sample: {
        issuer: SAMPLE_ISSUER,
        document: { number: "SAG-2026-000001", issuedOn: "2026-10-29" },
        vehicle: { ...SAMPLE_VEHICLE, odometer: 64_200 },
        buyer: {
          name: "Yaw Mensah",
          phone: "+233 24 555 0101",
          address: "5 Lake Road, Kumasi",
          ghanaCardNumber: "GHA-123456789-0",
        },
        deal: {
          number: "DEAL-2026-000003",
          price: money(15_500_000),
          hasDiscount: true,
          discount: money(500_000),
          invoiceNumber: "INV-2026-000120",
          invoiced: money(15_350_000),
          tradeIn: "Honda Civic 2012, GT 1234-12",
          tradeInValue: money(4_000_000),
          financing: "Instalments with the dealer",
          lender: null,
          loan: null,
          hasPlan: true,
          downPayment: money(2_000_000),
          instalments: 12,
          instalment: money(850_000),
          firstDueOn: "2026-11-29",
          lastDueOn: "2027-10-29",
          planCharge: money(850_000),
          warrantyMonths: 3,
          serviceVouchers: 2,
          notes: null,
        },
        addOns: [{ description: "Tracker", amount: money(200_000) }],
      },
    },
    dealer_delivery_note: {
      name: "Vehicle delivery note",
      numbering: "delivery_note_document",
      subjectType: "dealer_deal",
      fields: {
        issuer: ISSUER,
        document: DOCUMENT,
        vehicle: VEHICLE,
        buyer: { name: "text", phone: "text" },
        deal: { number: "text" },
        delivery: {
          deliveredOn: "date",
          odometer: "number",
          warrantyEndsOn: "date",
          serviceVouchers: "number",
        },
        checklist: listOf({ item: "text", checked: "boolean", note: "text" }),
      },
      system: { version: 1, body: DEALER_DELIVERY_NOTE_V1 },
      sample: {
        issuer: SAMPLE_ISSUER,
        document: { number: "DNT-2026-000001", issuedOn: "2026-10-29" },
        vehicle: SAMPLE_VEHICLE,
        buyer: { name: "Yaw Mensah", phone: "+233 24 555 0101" },
        deal: { number: "DEAL-2026-000003" },
        delivery: {
          deliveredOn: "2026-10-29",
          odometer: 64_250,
          warrantyEndsOn: "2027-01-29",
          serviceVouchers: 2,
        },
        checklist: [
          { item: "Keys and spare key", checked: true, note: null },
          { item: "DVLA transfer forms signed", checked: true, note: null },
          { item: "Customs papers", checked: false, note: "Bought locally: none" },
        ],
      },
    },
  });

export function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(value);
}
