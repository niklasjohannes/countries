// Map projections shared by the geometry and map-meta generators (zero dependencies).
// Degrees in, km out; see docs/DATA.md -> "Geometry" for the files that use them.

/** Mean Earth radius in km (spherical projections). */
export const EARTH_RADIUS_KM = 6371;

/**
 * Wrap a longitude into [centre - 180, centre + 180).
 * @param {number} lon
 * @param {number} centreLon
 * @returns {number}
 */
export function wrapLongitude(lon, centreLon) {
  if (!Number.isFinite(lon) || !Number.isFinite(centreLon)) {
    throw new TypeError('`lon` and `centreLon` must be finite numbers.');
  }
  let out = lon;
  while (out < centreLon - 180) out += 360;
  while (out >= centreLon + 180) out -= 360;
  return out;
}

const EE = { A1: 1.340264, A2: -0.081106, A3: 0.000893, A4: 0.003796, M: Math.sqrt(3) / 2 };
const RAD = Math.PI / 180;

/**
 * Build the projection for one geometry file, from degrees to km.
 * @param {{projection: string, centre: number[]}} spec
 * @returns {(lon: number, lat: number) => number[]}
 */
export function makeProjection(spec) {
  if (!spec || !Array.isArray(spec.centre) || spec.centre.length !== 2) {
    throw new TypeError('`spec` must have a `centre` of [lon, lat].');
  }
  const [lon0, lat0] = spec.centre;
  if (spec.projection === 'laea') {
    const sinPhi0 = Math.sin(lat0 * RAD);
    const cosPhi0 = Math.cos(lat0 * RAD);
    return (lon, lat) => {
      const lambda = (wrapLongitude(lon, lon0) - lon0) * RAD;
      const phi = lat * RAD;
      const cosC = sinPhi0 * Math.sin(phi) + cosPhi0 * Math.cos(phi) * Math.cos(lambda);
      const k = Math.sqrt(2 / (1 + cosC));
      return [
        EARTH_RADIUS_KM * k * Math.cos(phi) * Math.sin(lambda),
        EARTH_RADIUS_KM * k * (cosPhi0 * Math.sin(phi) - sinPhi0 * Math.cos(phi) * Math.cos(lambda))
      ];
    };
  }
  if (spec.projection === 'equal-earth') {
    return (lon, lat) => {
      const lambda = (lon - lon0) * RAD;
      const theta = Math.asin(EE.M * Math.sin(lat * RAD));
      const t2 = theta * theta;
      const t6 = t2 * t2 * t2;
      const x = (2 * Math.sqrt(3) * lambda * Math.cos(theta))
        / (3 * (9 * EE.A4 * t6 * t2 + 7 * EE.A3 * t6 + 3 * EE.A2 * t2 + EE.A1));
      const y = theta * (EE.A1 + EE.A2 * t2 + t6 * (EE.A3 + EE.A4 * t2));
      return [EARTH_RADIUS_KM * x, EARTH_RADIUS_KM * y];
    };
  }
  throw new RangeError(`Unknown projection \`${spec.projection}\`.`);
}

