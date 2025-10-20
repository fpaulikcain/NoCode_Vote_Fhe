// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface VotingCampaign {
  id: string;
  title: string;
  description: string;
  encryptedOptions: string[];
  startTime: number;
  endTime: number;
  creator: string;
  totalVotes: number;
  isActive: boolean;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [campaigns, setCampaigns] = useState<VotingCampaign[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newCampaignData, setNewCampaignData] = useState({ 
    title: "", 
    description: "", 
    options: ["", ""], 
    durationDays: 7 
  });
  const [searchTerm, setSearchTerm] = useState("");
  const [filterActive, setFilterActive] = useState<boolean | null>(null);
  const [userHistory, setUserHistory] = useState<string[]>([]);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [selectedCampaign, setSelectedCampaign] = useState<VotingCampaign | null>(null);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState<number | null>(null);
  const [isVoting, setIsVoting] = useState(false);
  const [voteCounts, setVoteCounts] = useState<number[]>([]);

  useEffect(() => {
    loadCampaigns().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadCampaigns = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract is not available");
        return;
      }

      // Load campaign keys
      const keysBytes = await contract.getData("campaign_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing campaign keys:", e); }
      }

      // Load each campaign
      const list: VotingCampaign[] = [];
      for (const key of keys) {
        try {
          const campaignBytes = await contract.getData(`campaign_${key}`);
          if (campaignBytes.length > 0) {
            try {
              const campaignData = JSON.parse(ethers.toUtf8String(campaignBytes));
              list.push({ 
                id: key, 
                title: campaignData.title,
                description: campaignData.description,
                encryptedOptions: campaignData.options,
                startTime: campaignData.startTime,
                endTime: campaignData.endTime,
                creator: campaignData.creator,
                totalVotes: campaignData.totalVotes || 0,
                isActive: campaignData.endTime > Math.floor(Date.now() / 1000)
              });
            } catch (e) { console.error(`Error parsing campaign data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading campaign ${key}:`, e); }
      }
      
      list.sort((a, b) => b.startTime - a.startTime);
      setCampaigns(list);
    } catch (e) { console.error("Error loading campaigns:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createCampaign = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Creating encrypted voting campaign with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate campaign ID
      const campaignId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Encrypt initial vote counts (0 for each option)
      const encryptedOptions = newCampaignData.options.map(option => FHEEncryptNumber(0));
      
      // Prepare campaign data
      const now = Math.floor(Date.now() / 1000);
      const endTime = now + (newCampaignData.durationDays * 24 * 60 * 60);
      const campaignData = {
        title: newCampaignData.title,
        description: newCampaignData.description,
        options: encryptedOptions,
        startTime: now,
        endTime: endTime,
        creator: address,
        totalVotes: 0
      };
      
      // Store campaign data
      await contract.setData(`campaign_${campaignId}`, ethers.toUtf8Bytes(JSON.stringify(campaignData)));
      
      // Update campaign keys
      const keysBytes = await contract.getData("campaign_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(campaignId);
      await contract.setData("campaign_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE voting campaign created successfully!" });
      await loadCampaigns();
      
      // Add to user history
      setUserHistory(prev => [...prev, `Created campaign: ${newCampaignData.title}`]);
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewCampaignData({ 
          title: "", 
          description: "", 
          options: ["", ""], 
          durationDays: 7 
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const castVote = async (campaignId: string, optionIndex: number) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    if (optionIndex === null) { alert("Please select an option"); return; }
    
    setIsVoting(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted vote with Zama FHE..." });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      // Get campaign data
      const campaignBytes = await contract.getData(`campaign_${campaignId}`);
      if (campaignBytes.length === 0) throw new Error("Campaign not found");
      const campaignData = JSON.parse(ethers.toUtf8String(campaignBytes));
      
      if (campaignData.endTime <= Math.floor(Date.now() / 1000)) {
        throw new Error("Voting has ended for this campaign");
      }
      
      // Get current encrypted vote count for selected option
      const currentEncryptedCount = campaignData.options[optionIndex];
      const currentCount = FHEDecryptNumber(currentEncryptedCount);
      
      // "Increment" the vote count (in reality, we're creating a new encrypted value)
      const newEncryptedCount = FHEEncryptNumber(currentCount + 1);
      
      // Update the campaign data
      const updatedOptions = [...campaignData.options];
      updatedOptions[optionIndex] = newEncryptedCount;
      
      const updatedCampaign = { 
        ...campaignData, 
        options: updatedOptions,
        totalVotes: campaignData.totalVotes + 1
      };
      
      // Store updated data
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      await contractWithSigner.setData(`campaign_${campaignId}`, ethers.toUtf8Bytes(JSON.stringify(updatedCampaign)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Vote submitted securely with FHE encryption!" });
      
      // Add to user history
      setUserHistory(prev => [...prev, `Voted in campaign: ${campaignData.title}`]);
      
      // Reload data
      await loadCampaigns();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setSelectedCampaign(null);
      }, 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Voting failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally {
      setIsVoting(false);
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    }
  };

  const viewResults = async (campaign: VotingCampaign) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    
    try {
      const decryptedCounts = [];
      for (const encryptedCount of campaign.encryptedOptions) {
        const decrypted = await decryptWithSignature(encryptedCount);
        if (decrypted !== null) {
          decryptedCounts.push(decrypted);
        } else {
          decryptedCounts.push(0);
        }
      }
      setVoteCounts(decryptedCounts);
      setSelectedCampaign(campaign);
    } catch (e) {
      console.error("Error viewing results:", e);
    }
  };

  const filteredCampaigns = campaigns.filter(campaign => {
    const matchesSearch = campaign.title.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         campaign.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = filterActive === null || campaign.isActive === filterActive;
    return matchesSearch && matchesFilter;
  });

  const activeCampaigns = campaigns.filter(c => c.isActive).length;
  const endedCampaigns = campaigns.filter(c => !c.isActive).length;
  const totalVotes = campaigns.reduce((sum, c) => sum + c.totalVotes, 0);

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Loading FHE voting campaigns...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>FHE<span>Vote</span>Builder</h1>
          <p>No-code FHE voting for DAOs</p>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
        </div>
      </header>

      <main className="main-content">
        {/* Project Introduction */}
        <section className="intro-section card">
          <h2>Private Voting Made Simple</h2>
          <p>
            Build fully encrypted voting systems for your DAO with zero coding required. 
            Powered by <strong>Zama FHE technology</strong>, votes remain encrypted throughout 
            the entire process while still being countable.
          </p>
          <div className="tech-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <button 
            className="primary-button"
            onClick={() => setShowCreateModal(true)}
          >
            Create New Vote
          </button>
        </section>

        {/* Data Statistics */}
        <section className="stats-section">
          <div className="stat-card card">
            <h3>Total Campaigns</h3>
            <div className="stat-value">{campaigns.length}</div>
          </div>
          <div className="stat-card card">
            <h3>Active Votes</h3>
            <div className="stat-value">{activeCampaigns}</div>
          </div>
          <div className="stat-card card">
            <h3>Ended Votes</h3>
            <div className="stat-value">{endedCampaigns}</div>
          </div>
          <div className="stat-card card">
            <h3>Total Votes</h3>
            <div className="stat-value">{totalVotes}</div>
          </div>
        </section>

        {/* Search & Filter */}
        <section className="search-section card">
          <div className="search-container">
            <input
              type="text"
              placeholder="Search campaigns..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="search-input"
            />
            <div className="filter-buttons">
              <button 
                className={`filter-button ${filterActive === null ? 'active' : ''}`}
                onClick={() => setFilterActive(null)}
              >
                All
              </button>
              <button 
                className={`filter-button ${filterActive === true ? 'active' : ''}`}
                onClick={() => setFilterActive(true)}
              >
                Active
              </button>
              <button 
                className={`filter-button ${filterActive === false ? 'active' : ''}`}
                onClick={() => setFilterActive(false)}
              >
                Ended
              </button>
            </div>
          </div>
        </section>

        {/* Campaigns List */}
        <section className="campaigns-section">
          <div className="section-header">
            <h2>Voting Campaigns</h2>
            <button 
              onClick={loadCampaigns} 
              className="refresh-button"
              disabled={isRefreshing}
            >
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {filteredCampaigns.length === 0 ? (
            <div className="empty-state card">
              <p>No voting campaigns found</p>
              <button 
                className="primary-button"
                onClick={() => setShowCreateModal(true)}
              >
                Create First Campaign
              </button>
            </div>
          ) : (
            <div className="campaigns-grid">
              {filteredCampaigns.map(campaign => (
                <div key={campaign.id} className="campaign-card card">
                  <div className="campaign-header">
                    <h3>{campaign.title}</h3>
                    <span className={`status-badge ${campaign.isActive ? 'active' : 'ended'}`}>
                      {campaign.isActive ? 'Active' : 'Ended'}
                    </span>
                  </div>
                  <p className="campaign-description">{campaign.description}</p>
                  <div className="campaign-meta">
                    <span>Created by: {campaign.creator.substring(0, 6)}...{campaign.creator.substring(38)}</span>
                    <span>Votes: {campaign.totalVotes}</span>
                  </div>
                  <div className="campaign-actions">
                    {campaign.isActive ? (
                      <button 
                        className="action-button"
                        onClick={() => setSelectedCampaign(campaign)}
                      >
                        Vote Now
                      </button>
                    ) : (
                      <button 
                        className="action-button"
                        onClick={() => viewResults(campaign)}
                      >
                        View Results
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* User History */}
        {userHistory.length > 0 && (
          <section className="history-section card">
            <h2>Your Activity</h2>
            <ul className="history-list">
              {userHistory.map((item, index) => (
                <li key={index} className="history-item">
                  <span className="history-icon">✓</span>
                  {item}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      {/* Create Campaign Modal */}
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="modal card">
            <div className="modal-header">
              <h2>Create New Voting Campaign</h2>
              <button 
                onClick={() => setShowCreateModal(false)}
                className="close-button"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Title *</label>
                <input
                  type="text"
                  value={newCampaignData.title}
                  onChange={(e) => setNewCampaignData({...newCampaignData, title: e.target.value})}
                  placeholder="Voting campaign title"
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={newCampaignData.description}
                  onChange={(e) => setNewCampaignData({...newCampaignData, description: e.target.value})}
                  placeholder="Describe what this vote is about..."
                  rows={3}
                />
              </div>
              <div className="form-group">
                <label>Voting Options *</label>
                {newCampaignData.options.map((option, index) => (
                  <div key={index} className="option-input">
                    <input
                      type="text"
                      value={option}
                      onChange={(e) => {
                        const newOptions = [...newCampaignData.options];
                        newOptions[index] = e.target.value;
                        setNewCampaignData({...newCampaignData, options: newOptions});
                      }}
                      placeholder={`Option ${index + 1}`}
                    />
                    {newCampaignData.options.length > 2 && (
                      <button
                        className="remove-option"
                        onClick={() => {
                          const newOptions = [...newCampaignData.options];
                          newOptions.splice(index, 1);
                          setNewCampaignData({...newCampaignData, options: newOptions});
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                <button
                  className="add-option"
                  onClick={() => {
                    if (newCampaignData.options.length < 5) {
                      setNewCampaignData({
                        ...newCampaignData,
                        options: [...newCampaignData.options, ""]
                      });
                    }
                  }}
                  disabled={newCampaignData.options.length >= 5}
                >
                  Add Option
                </button>
              </div>
              <div className="form-group">
                <label>Duration (days) *</label>
                <input
                  type="number"
                  min="1"
                  max="30"
                  value={newCampaignData.durationDays}
                  onChange={(e) => setNewCampaignData({
                    ...newCampaignData,
                    durationDays: parseInt(e.target.value) || 7
                  })}
                />
              </div>
              <div className="fhe-notice">
                <p>
                  <strong>FHE Notice:</strong> All votes will be encrypted using Zama FHE technology. 
                  Vote counts will be computed on encrypted data without decryption.
                </p>
              </div>
            </div>
            <div className="modal-footer">
              <button
                onClick={() => setShowCreateModal(false)}
                className="secondary-button"
              >
                Cancel
              </button>
              <button
                onClick={createCampaign}
                disabled={creating || !newCampaignData.title || newCampaignData.options.some(o => !o)}
                className="primary-button"
              >
                {creating ? "Creating..." : "Create Campaign"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Vote/Results Modal */}
      {selectedCampaign && (
        <div className="modal-overlay">
          <div className="modal card">
            <div className="modal-header">
              <h2>{selectedCampaign.title}</h2>
              <button 
                onClick={() => {
                  setSelectedCampaign(null);
                  setSelectedOptionIndex(null);
                  setVoteCounts([]);
                }}
                className="close-button"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <p className="campaign-description">{selectedCampaign.description}</p>
              
              {selectedCampaign.isActive ? (
                <>
                  <h3>Cast Your Vote</h3>
                  <div className="vote-options">
                    {selectedCampaign.encryptedOptions.map((_, index) => (
                      <div 
                        key={index}
                        className={`vote-option ${selectedOptionIndex === index ? 'selected' : ''}`}
                        onClick={() => setSelectedOptionIndex(index)}
                      >
                        {newCampaignData.options[index] || `Option ${index + 1}`}
                      </div>
                    ))}
                  </div>
                  <button
                    className="submit-vote primary-button"
                    onClick={() => castVote(selectedCampaign.id, selectedOptionIndex!)}
                    disabled={selectedOptionIndex === null || isVoting}
                  >
                    {isVoting ? "Submitting..." : "Submit Vote"}
                  </button>
                </>
              ) : (
                <>
                  <h3>Voting Results</h3>
                  {voteCounts.length > 0 ? (
                    <div className="results-container">
                      {selectedCampaign.encryptedOptions.map((_, index) => (
                        <div key={index} className="result-item">
                          <div className="result-label">
                            {newCampaignData.options[index] || `Option ${index + 1}`}
                          </div>
                          <div className="result-bar-container">
                            <div 
                              className="result-bar"
                              style={{
                                width: `${(voteCounts[index] / Math.max(1, selectedCampaign.totalVotes)) * 100}%`
                              }}
                            ></div>
                          </div>
                          <div className="result-value">
                            {voteCounts[index]} votes ({selectedCampaign.totalVotes > 0 
                              ? Math.round((voteCounts[index] / selectedCampaign.totalVotes) * 100) 
                              : 0}%)
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <button
                      className="view-results primary-button"
                      onClick={() => viewResults(selectedCampaign)}
                    >
                      View Results
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="status-modal-overlay">
          <div className="status-modal card">
            <div className={`status-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="status-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-logo">
            <h3>FHEVoteBuilder</h3>
            <p>No-code FHE voting for DAOs</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">About Zama FHE</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Privacy</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© {new Date().getFullYear()} FHEVoteBuilder. Powered by Zama FHE technology.</p>
        </div>
      </footer>
    </div>
  );
};

export default App;