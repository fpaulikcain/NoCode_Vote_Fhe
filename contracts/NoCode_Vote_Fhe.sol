pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract NoCodeVoteFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidArgument();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    address public owner;
    mapping(address => bool) public providers;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool isOpen;
    }
    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => mapping(address => euint32)) public encryptedVotes;
    mapping(uint256 => euint32) public encryptedTotalVotes;
    mapping(uint256 => uint256) public voteCounts;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownSecondsUpdated(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event VoteSubmitted(address indexed voter, uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalVotes);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier submissionCooldown(address submitter) {
        if (block.timestamp < lastSubmissionTime[submitter] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier decryptionRequestCooldown(address requester) {
        if (block.timestamp < lastDecryptionRequestTime[requester] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[owner] = true;
        cooldownSeconds = 60;
        currentBatchId = 1;
        _openBatch(currentBatchId);
        emit OwnershipTransferred(address(0), owner);
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidArgument();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidArgument();
        if (!providers[provider]) {
            providers[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (providers[provider]) {
            providers[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert InvalidArgument();
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidArgument();
        emit CooldownSecondsUpdated(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openBatch() external onlyOwner {
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function _openBatch(uint256 batchId) private {
        if (batches[batchId].id != 0) revert InvalidArgument(); // Batch already exists
        batches[batchId] = Batch({id: batchId, isOpen: true});
        encryptedTotalVotes[batchId] = FHE.asEuint32(0);
        emit BatchOpened(batchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (batchId == 0 || batches[batchId].id != batchId || !batches[batchId].isOpen) revert BatchClosed();
        batches[batchId].isOpen = false;
        emit BatchClosed(batchId);
    }

    function submitVote(uint256 batchId, euint32 encryptedVote) external onlyProvider whenNotPaused submissionCooldown(msg.sender) {
        if (batchId == 0 || batches[batchId].id != batchId || !batches[batchId].isOpen) revert BatchClosed();
        _initIfNeeded(encryptedVote);
        encryptedVotes[batchId][msg.sender] = encryptedVote;
        encryptedTotalVotes[batchId] = encryptedTotalVotes[batchId].add(encryptedVote);
        voteCounts[batchId]++;
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit VoteSubmitted(msg.sender, batchId);
    }

    function requestBatchTotalDecryption(uint256 batchId) external onlyProvider whenNotPaused decryptionRequestCooldown(msg.sender) {
        if (batchId == 0 || batches[batchId].id != batchId || batches[batchId].isOpen) revert BatchNotClosed();
        _requireInitialized(encryptedTotalVotes[batchId]);
        euint32 memory totalVoteCt = encryptedTotalVotes[batchId];
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(totalVoteCt);
        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();
        DecryptionContext memory ctx = decryptionContexts[requestId];
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(encryptedTotalVotes[ctx.batchId]);
        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != ctx.stateHash) {
            revert StateMismatch();
        }
        FHE.checkSignatures(requestId, cleartexts, proof);
        uint256 totalVotes = abi.decode(cleartexts, (uint256));
        ctx.processed = true;
        decryptionContexts[requestId] = ctx;
        emit DecryptionCompleted(requestId, ctx.batchId, totalVotes);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 memory ct) internal pure {
        if (!FHE.isInitialized(ct)) revert NotInitialized();
    }

    function _requireInitialized(euint32 memory ct) internal pure {
        if (!FHE.isInitialized(ct)) revert NotInitialized();
    }
}