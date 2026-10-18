import QRCode from "qrcode";
import type { IQrCodeRenderer } from "../../application/ports/IConnectLinkSigner.js";

/** QR codes as SVG (medium error correction: survives a printed sticker getting scuffed). */
export class QrcodeSvgRenderer implements IQrCodeRenderer {
  svg(text: string): Promise<string> {
    return QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  }
}
