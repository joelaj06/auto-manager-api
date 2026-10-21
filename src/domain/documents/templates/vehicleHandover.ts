/** System template: vehicle handover to a driver (version 1). */
export const VEHICLE_HANDOVER_V1 = `<h1 class="center">Vehicle handover</h1>
<p class="center small">{{document.number}} · {{date document.issuedOn}}</p>

<h2>Parties</h2>
<table>
  <tr><th data-width="30">Business</th><td>{{issuer.name}}{{#if issuer.tin}} (TIN {{issuer.tin}}){{/if}}</td></tr>
  <tr><th>Driver</th><td>{{driver.name}} ({{driver.code}}), {{driver.phone}}</td></tr>
  <tr><th>Driving licence</th><td>{{driver.licenceNumber}}</td></tr>
</table>

<h2>Vehicle</h2>
<table>
  <tr><th data-width="30">Registration</th><td>{{upper vehicle.plateNumber}}</td></tr>
  <tr><th>Make and model</th><td>{{vehicle.make}} {{vehicle.model}}{{#if vehicle.year}} ({{vehicle.year}}){{/if}}</td></tr>
  <tr><th>Colour</th><td>{{vehicle.colour}}</td></tr>
  <tr><th>Chassis / VIN</th><td>{{vehicle.vin}}</td></tr>
  <tr><th>Odometer at handover</th><td>{{number handover.odometer}} {{handover.unit}}</td></tr>
  <tr><th>Handed over</th><td>{{date handover.startedAt}} at {{handover.branch}}</td></tr>
</table>

<h2>Condition checklist</h2>
<table>
  <thead><tr><th data-width="8">#</th><th data-width="52">Item</th><th data-width="15">OK</th><th>Note</th></tr></thead>
  <tbody>
  {{#each checklist}}<tr><td>{{@number}}</td><td>{{label}}</td><td>{{ok}}</td><td>{{note}}</td></tr>
  {{/each}}
  </tbody>
</table>

{{#if terms.target}}
<h2>Remittance terms</h2>
<p>The driver remits <strong>{{money terms.target}}</strong> {{terms.frequency}}{{#if terms.daysOff}}, except on {{terms.daysOff}}{{/if}}.</p>
{{/if}}

<section data-clause="driver_responsibility" data-title="Driver's responsibility" data-locked>
<p>The driver confirms that the vehicle, its documents and the items above were received in the condition recorded. The driver will use the vehicle with care, only for the agreed work, obey road traffic law, and report any accident, damage, breakdown or police matter to the business at once. Fines and charges caused by the driver are the driver's to pay unless the business agrees otherwise in writing.</p>
</section>

<section data-clause="return_of_vehicle" data-title="Return of the vehicle">
<p>The vehicle is returned on request of the business, or when the assignment ends, with its documents, keys and accessories, in the same condition apart from fair wear and tear.</p>
</section>

<signature-block>
  <signer role="business" label="For the business" name="{{issuer.name}}"></signer>
  <signer role="driver" label="Driver" name="{{driver.name}}"></signer>
</signature-block>
`;
