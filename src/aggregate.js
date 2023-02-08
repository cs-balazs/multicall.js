import invariant from 'invariant';
import { strip0x, ethCall, encodeParameters, decodeParameters } from './helpers.js';
import memoize from 'lodash/memoize';
import { Interface, keccak256, toUtf8Bytes } from 'ethers/lib/utils';

const INSIDE_EVERY_PARENTHESES = /\(.*?\)/g;
const FIRST_CLOSING_PARENTHESES = /^[^)]*\)/;

export function _makeMulticallData(calls) {
  const values = [
    calls.map(({ target, method, args }) => [
      target,
      keccak256(toUtf8Bytes(method)).substr(0, 10) +
        (args && args.length > 0
          ? strip0x(
              encodeParameters(
                args.map((a) => a[1]),
                args.map((a) => a[0])
              )
            )
          : ''),
    ]),
  ];
  const calldata = encodeParameters(
    [
      {
        components: [{ type: 'address' }, { type: 'bytes' }],
        name: 'data',
        type: 'tuple[]',
      },
    ],
    values
  );
  return calldata;
}

const makeMulticallData = memoize(_makeMulticallData, (...args) => JSON.stringify(args));

export default async function aggregate(calls, config) {
  calls = Array.isArray(calls) ? calls : [calls];

  const keyToArgMap = calls.reduce((acc, { call, returns }) => {
    const [, ...args] = call;
    if (args.length > 0) {
      for (let returnMeta of returns) {
        const [key] = returnMeta;
        acc[key] = args;
      }
    }
    return acc;
  }, {});

  calls = calls.map(({ call, target, returns }) => {
    if (!target) target = config.multicallAddress;
    const [method, ...argValues] = call;
    const [argTypesString, returnTypesString] = method
      .match(INSIDE_EVERY_PARENTHESES)
      .map((match) => match.slice(1, -1));
    const argTypes = argTypesString.split(',').filter((e) => !!e);
    invariant(
      argTypes.length === argValues.length,
      `Every method argument must have exactly one type.
          Comparing argument types ${JSON.stringify(argTypes)}
          to argument values ${JSON.stringify(argValues)}.
        `
    );
    const args = argValues.map((argValue, idx) => [argValue, argTypes[idx]]);
    const returnTypes = !!returnTypesString ? returnTypesString.split(',') : [];
    return {
      method: method.match(FIRST_CLOSING_PARENTHESES)[0],
      args,
      returnTypes,
      target,
      returns,
    };
  });

  const callDataBytes = makeMulticallData(calls, false);
  const outerResults = await ethCall(callDataBytes, config);
  const returnTypeArray = calls
    .map(({ returnTypes }) => returnTypes)
    .reduce((acc, ele) => acc.concat(ele), []);
  const returnDataMeta = calls
    .map(({ returns }) => returns)
    .reduce((acc, ele) => acc.concat(ele), []);

  invariant(
    returnTypeArray.length === returnDataMeta.length,
    'Missing data needed to parse results'
  );

  const outerResultsDecoded = decodeParameters(['uint256', 'bytes[]'], outerResults);
  const blockNumber = outerResultsDecoded.shift();
  const parsedVals = outerResultsDecoded.reduce((acc, r) => {
    r.forEach((results, idx) => {
      const types = calls[idx].returnTypes;
      const resultsDecoded = decodeParameters(types, results);
      acc.push(
        ...resultsDecoded.map((r, idx) => {
          if (types[idx] === 'bool') return r.toString() === 'true';
          return r;
        })
      );
    });
    return acc;
  }, []);

  const retObj = { blockNumber, original: {}, transformed: {} };

  for (let i = 0; i < parsedVals.length; i++) {
    const [name, transform] = returnDataMeta[i];
    retObj.original[name] = parsedVals[i];
    retObj.transformed[name] = transform !== undefined ? transform(parsedVals[i]) : parsedVals[i];
  }

  return { results: retObj, keyToArgMap };
}

export async function aggregateDecodedFromABI(calls, config) {
  calls = Array.isArray(calls) ? calls : [calls];

  const interfacesByContractAddress = Object.fromEntries(
    calls.map(({ abi, target }) => [target, new Interface(abi)])
  );

  calls = calls.map(({ call, target }) => {
    const contractInterface = interfacesByContractAddress[target];
    if (!target) target = config.multicallAddress;
    const [method, ...argValues] = call;

    const argTypes = contractInterface.getFunction(method).inputs.map((i) => i.type);

    invariant(
      argTypes.length === argValues.length,
      `Every method argument must have exactly one type.
          Comparing argument types ${JSON.stringify(argTypes)}
          to argument values ${JSON.stringify(argValues)}.
        `
    );
    const args = argValues.map((argValue, idx) => [argValue, argTypes[idx]]);
    return {
      method: `${method}(${argTypes.join(',')})`,
      args,
      target,
    };
  });

  const callDataBytes = makeMulticallData(calls, false);
  const outerResults = await ethCall(callDataBytes, config);

  const decoded = MULTICALL_ABI.decodeFunctionResult('aggregate', outerResults)[1];

  return decoded.map((result, i) =>
    interfacesByContractAddress[calls[i].target].decodeFunctionResult(calls[i].method, result)
  );
}

const MULTICALL_ABI = new Interface([
  {
    constant: true,
    inputs: [],
    name: 'getCurrentBlockTimestamp',
    outputs: [{ name: 'timestamp', type: 'uint256' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      {
        components: [
          { name: 'target', type: 'address' },
          { name: 'callData', type: 'bytes' },
        ],
        name: 'calls',
        type: 'tuple[]',
      },
    ],
    name: 'aggregate',
    outputs: [
      { name: 'blockNumber', type: 'uint256' },
      { name: 'returnData', type: 'bytes[]' },
    ],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'getLastBlockHash',
    outputs: [{ name: 'blockHash', type: 'bytes32' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [{ name: 'addr', type: 'address' }],
    name: 'getEthBalance',
    outputs: [{ name: 'balance', type: 'uint256' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'getCurrentBlockDifficulty',
    outputs: [{ name: 'difficulty', type: 'uint256' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'getCurrentBlockGasLimit',
    outputs: [{ name: 'gaslimit', type: 'uint256' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'getCurrentBlockCoinbase',
    outputs: [{ name: 'coinbase', type: 'address' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [{ name: 'blockNumber', type: 'uint256' }],
    name: 'getBlockHash',
    outputs: [{ name: 'blockHash', type: 'bytes32' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
]);
