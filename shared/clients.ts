import type {Currency} from './contracts.js';

export interface ClientRecord {
  id:string;
  name:string;
  email?:string;
  /** Normalized lowercase 64-character public key; no relay hints are stored. */
  marmotPubkey?:string;
  billingAddress?:string;
  currency:Currency;
  notes?:string;
  createdAt:string;
  updatedAt:string;
}

/**
 * Save replaces all editable fields. Omitted currency defaults to CAD, and
 * omitted or blank optional fields clear their previous values.
 * An id updates an existing client in the caller's workspace; omission creates.
 */
export interface ClientInput {
  id?:string;
  name:string;
  email?:string;
  /** Accepts npub, nprofile or 64-character hexadecimal public keys. */
  marmotPubkey?:string;
  billingAddress?:string;
  currency?:Currency;
  notes?:string;
}
