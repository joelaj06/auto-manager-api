/** System template: the delivery note when a sold vehicle is handed over (version 1). */
export const DEALER_DELIVERY_NOTE_V1 = `<h1 class="center">Delivery Note</h1>
<p class="center small">{{document.number}} · {{date delivery.deliveredOn}} · deal {{deal.number}}</p>

<table>
  <tr><th data-width="30">Delivered to</th><td>{{buyer.name}}{{#if buyer.phone}}, {{buyer.phone}}{{/if}}</td></tr>
  <tr><th>Vehicle</th><td>{{vehicle.make}} {{vehicle.model}}{{#if vehicle.year}} ({{vehicle.year}}){{/if}}{{#if vehicle.plateNumber}}, {{upper vehicle.plateNumber}}{{/if}}</td></tr>
  {{#if vehicle.vin}}<tr><th>VIN</th><td>{{vehicle.vin}}</td></tr>{{/if}}
  <tr><th>Odometer</th><td>{{number delivery.odometer}}</td></tr>
  {{#if delivery.warrantyEndsOn}}<tr><th>Warranty until</th><td>{{date delivery.warrantyEndsOn}}</td></tr>{{/if}}
  {{#if delivery.serviceVouchers}}<tr><th>Free services</th><td>{{delivery.serviceVouchers}}</td></tr>{{/if}}
</table>

<h2>Handed over</h2>
<table>
  <thead><tr><th data-width="60">Item</th><th data-width="15">Handed over</th><th>Note</th></tr></thead>
  <tbody>
  {{#each checklist}}<tr><td>{{item}}</td><td>{{#if checked}}Yes{{/if}}</td><td>{{note}}</td></tr>
  {{/each}}
  </tbody>
</table>

<section data-clause="delivery_receipt" data-title="Receipt" data-locked>
<p>The buyer received the vehicle in the condition seen and the items marked above. Anything not handed over is noted against it.</p>
</section>

<signature-block>
  <signer role="business" label="Handed over by" name="{{issuer.name}}"></signer>
  <signer role="buyer" label="Received by" name="{{buyer.name}}"></signer>
</signature-block>
`;
