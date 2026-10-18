import { describe, expect, it } from 'vitest';
import {
  findNonMskBrokers,
  hasForbiddenOAuthExtensionChars,
  isMskBrokerHostForRegion,
  isPlaintextTokenEndpointAllowed,
  MAX_OAUTH_EXTENSIONS,
} from './kafka-sasl-policy';

describe('isMskBrokerHostForRegion', () => {
  it('accepts provisioned, serverless and China-partition MSK broker hosts in the signer region', () => {
    expect(
      isMskBrokerHostForRegion('b-1.mycluster.abc123.c2.kafka.us-east-1.amazonaws.com', 'us-east-1')
    ).toBe(true);
    expect(
      isMskBrokerHostForRegion('boot-abc.c1.kafka-serverless.eu-west-1.amazonaws.com', 'eu-west-1')
    ).toBe(true);
    expect(isMskBrokerHostForRegion('b-2.c.kafka.cn-north-1.amazonaws.com.cn', 'cn-north-1')).toBe(
      true
    );
    expect(isMskBrokerHostForRegion('B-1.X.KAFKA.US-EAST-1.AMAZONAWS.COM.', 'us-east-1')).toBe(
      true
    );
  });

  it('rejects other regions, look-alike suffixes and arbitrary hosts', () => {
    expect(isMskBrokerHostForRegion('b-1.c.kafka.us-west-2.amazonaws.com', 'us-east-1')).toBe(
      false
    );
    expect(isMskBrokerHostForRegion('kafka.us-east-1.amazonaws.com', 'us-east-1')).toBe(false);
    expect(
      isMskBrokerHostForRegion('b-1.kafka.us-east-1.amazonaws.com.evil.example', 'us-east-1')
    ).toBe(false);
    expect(isMskBrokerHostForRegion('evil-kafka.us-east-1.amazonaws.com', 'us-east-1')).toBe(false);
    expect(isMskBrokerHostForRegion('broker.example.com', 'us-east-1')).toBe(false);
    expect(isMskBrokerHostForRegion('10.0.0.5', 'us-east-1')).toBe(false);
  });

  it('lists the brokers that are not MSK hosts for the region', () => {
    expect(
      findNonMskBrokers(
        ['b-1.c.kafka.us-east-1.amazonaws.com:9098', 'attacker.example:9098'],
        'us-east-1'
      )
    ).toEqual(['attacker.example:9098']);
  });
});

describe('isPlaintextTokenEndpointAllowed', () => {
  it('always allows https', () => {
    expect(isPlaintextTokenEndpointAllowed('https://idp.example.com/token')).toBe(true);
  });

  it('allows http only for loopback or private IP literals', () => {
    expect(isPlaintextTokenEndpointAllowed('http://localhost:8080/token')).toBe(true);
    expect(isPlaintextTokenEndpointAllowed('http://127.0.0.1/token')).toBe(true);
    expect(isPlaintextTokenEndpointAllowed('http://[::1]/token')).toBe(true);
    expect(isPlaintextTokenEndpointAllowed('http://10.1.2.3/token')).toBe(true);
    expect(isPlaintextTokenEndpointAllowed('http://idp.example.com/token')).toBe(false);
    expect(isPlaintextTokenEndpointAllowed('http://8.8.8.8/token')).toBe(false);
    expect(isPlaintextTokenEndpointAllowed('ftp://localhost/token')).toBe(false);
    expect(isPlaintextTokenEndpointAllowed('not a url')).toBe(false);
  });
});

describe('hasForbiddenOAuthExtensionChars', () => {
  it('flags control characters including the SASL \\x01 separator', () => {
    expect(hasForbiddenOAuthExtensionChars('ok-value')).toBe(false);
    expect(hasForbiddenOAuthExtensionChars('a\x01auth=Bearer x')).toBe(true);
    expect(hasForbiddenOAuthExtensionChars('a\nb')).toBe(true);
    expect(hasForbiddenOAuthExtensionChars('a\x00')).toBe(true);
    expect(MAX_OAUTH_EXTENSIONS).toBe(32);
  });
});
