import { parseAbi } from 'viem'

export const safeAbi = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function changeThreshold(uint256 _threshold)',
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function removeOwner(address prevOwner, address owner, uint256 _threshold)',
  'function nonce() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
  'event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 indexed txHash, uint256 payment)',
  'event SafeMultiSigTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures, bytes additionalInfo)',
  'event SafeReceived(address indexed sender, uint256 value)',
  'event AddedOwner(address indexed owner)',
  'event RemovedOwner(address indexed owner)',
  'event ChangedThreshold(uint256 threshold)',
])

export const transferEvent = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])

export const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

export const multiSendAbi = parseAbi(['function multiSend(bytes transactions) payable'])
