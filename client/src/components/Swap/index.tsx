import React, { useEffect, useMemo, useState, ChangeEvent } from "react";
import styled from 'styled-components';
import {
  useContractWrite,
  usePrepareContractWrite,
  useWaitForTransaction
} from 'wagmi'
import { useNavigate } from 'react-router-dom';

import { ArrowLeft } from 'react-feather';

import { Input } from "@components/Swap/Input";
import { OnRamperIntentTable } from '@components/Swap/OnRamperIntentTable'
import { AutoColumn } from '@components/layouts/Column'
import { Button } from '@components/Button'
import { CustomConnectButton } from "@components/common/ConnectButton"
import { ThemedText } from '../../theme/text'
import { IndicativeQuote } from '../../contexts/Deposits/types'
import { DEPOSIT_REFETCH_INTERVAL, VENMO_MAX_TRANSFER_SIZE, ZERO } from "@helpers/constants";
import { toBigInt, toUsdcString } from '@helpers/units'
import useAccount from '@hooks/useAccount';
import useBalances from '@hooks/useBalance';
import useOnRamperIntents from '@hooks/useOnRamperIntents';
import useRampState from "@hooks/useRampState";
import useSmartContracts from '@hooks/useSmartContracts';
import useLiquidity from '@hooks/useLiquidity';
import useRegistration from "@hooks/useRegistration";

import { HaloGateway } from "@arx-research/libhalo/api/desktop.js";
import websocket from "websocket";


export type SwapQuote = {
  requestedUSDC: string;
  fiatToSend: string;
  depositId: bigint;
};

const QuoteState = {
  DEFAULT: 'default',
  EXCEEDS_ORDER_COUNT: 'exceeds-order-count',
  EXCEEDS_MAX_SIZE: 'exceeds-max-size',
  INSUFFICIENT_LIQUIDITY: 'insufficient-liquidity',
  ORDER_COOLDOWN_PERIOD: 'order-cooldown-period',
  BLOCKED_BY_DEPOSITOR: 'blocked-by-depositor',
  SUCCESS: 'success',
}

interface SwapProps {
  onIntentTableRowClick?: () => void;
}

const Swap: React.FC<SwapProps> = ({
  onIntentTableRowClick
}: SwapProps) => {
  const navigate = useNavigate();

  /*
   * Contexts
   */


  const { isLoggedIn, loggedInEthereumAddress } = useAccount();
  const { usdcBalance } = useBalances();
  const { isRegistered } = useRegistration();
  const { currentIntentHash, refetchIntentHash, shouldFetchIntentHash, lastOnRampTimestamp, refetchLastOnRampTimestamp } = useOnRamperIntents();
  const { refetchDeposits, getBestDepositForAmount, shouldFetchDeposits } = useLiquidity();
  const { rampAddress, rampAbi, usdcAddress } = useSmartContracts();
  const { refetchDepositCounter, shouldFetchRampState, onRampCooldownPeriod } = useRampState();

  /*
   * State
   */

  const [quoteState, setQuoteState] = useState(QuoteState.DEFAULT);
  const [currentQuote, setCurrentQuote] = useState<SwapQuote>({ requestedUSDC: '', fiatToSend: '' , depositId: ZERO });
  const [loadCard, setLoadCard] = useState<boolean>(false);
  const [cardQrCode, setCardQrCode] = useState<string>('');
  const [cardAddress, setCardAddress] = useState<string>('');
  const [cardBalance, setCardBalance] = useState<string>('');

  const [shouldConfigureSignalIntentWrite, setShouldConfigureSignalIntentWrite] = useState<boolean>(false);

  /*
   * Event Handlers
   */

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>, field: keyof SwapQuote) => {
    if (field === 'requestedUSDC') {
      const value = event.target.value;
      const quoteCopy = {...currentQuote}
      setShouldConfigureSignalIntentWrite(false);

      if (value === "") {
        quoteCopy[field] = '';
        quoteCopy.depositId = ZERO;

        setCurrentQuote(quoteCopy);
      } else if (value === ".") {
        quoteCopy[field] = "0.";
        quoteCopy.depositId = ZERO;

        setCurrentQuote(quoteCopy);
      }
      else if (isValidInput(value)) {
        quoteCopy[field] = event.target.value;

        setCurrentQuote(quoteCopy);
      }
    } else {
      const quoteCopy = {...currentQuote}
      quoteCopy[field] = event.target.value;

      setCurrentQuote(quoteCopy);
    }
  };

  const handleEnterPress = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      // Prevent the default action
      event.preventDefault();

      // Call the handleAdd function
      handleAdd(event as any);
    }
  };

  const handleAdd = (event: React.FormEvent<HTMLButtonElement>) => {
    // Prevent the default form submit action
    event.preventDefault();

    // Reset form fields
    setCurrentQuote({ requestedUSDC: '', fiatToSend: '', depositId: ZERO });
  };

  const handleLoadCard = (event: React.KeyboardEvent<HTMLInputElement>) => {
    setLoadCard(!loadCard);
  }

  /*
   * Contract Writes
   */

  //
  // function signalIntent(uint256 _depositId, uint256 _amount, address _to)
  //
  const { config: writeIntentConfig } = usePrepareContractWrite({
    address: rampAddress,
    abi: rampAbi,
    functionName: 'signalIntent',
    args: [
      currentQuote.depositId,
      toBigInt(currentQuote.requestedUSDC),
      cardAddress != '' ? cardAddress : loggedInEthereumAddress
    ],
    onError: (error: { message: any }) => {
      console.error(error.message);
    },
    enabled: shouldConfigureSignalIntentWrite
  });

  const {
    data: submitIntentResult,
    isLoading: isSubmitIntentLoading,
    writeAsync: writeSubmitIntentAsync
  } = useContractWrite(writeIntentConfig);

  const {
    isLoading: isSubmitIntentMining
  } = useWaitForTransaction({
    hash: submitIntentResult ? submitIntentResult.hash : undefined,
    onSuccess(data) {
      console.log('writeSubmitIntentAsync successful: ', data);

      refetchIntentHash?.();
      refetchLastOnRampTimestamp?.();
    },
  });

  /*
   * Hooks
   */

  useEffect(() => {
    if (shouldFetchIntentHash) {
      const intervalId = setInterval(() => {
        refetchIntentHash?.();
      }, DEPOSIT_REFETCH_INTERVAL);

      return () => clearInterval(intervalId);
    }
  }, [shouldFetchIntentHash, refetchIntentHash]);

  useEffect(() => {
    if (shouldFetchDeposits) {
      const intervalId = setInterval(() => {
        refetchDeposits?.();
      }, DEPOSIT_REFETCH_INTERVAL);

      return () => clearInterval(intervalId);
    }
  }, [shouldFetchDeposits, refetchDeposits]);

  useEffect(() => {
    if (shouldFetchRampState) {
      const intervalId = setInterval(() => {
        refetchDepositCounter?.();
      }, DEPOSIT_REFETCH_INTERVAL);

      return () => clearInterval(intervalId);
    }
  }, [shouldFetchRampState, refetchDepositCounter]);

  useEffect(() => {
    const getGateway = async () => {
      let gate = new HaloGateway('wss://s1.halo-gateway.arx.org', {
        createWebSocket: (url: string) => new websocket.w3cwebsocket(url)
      });
      let pairInfo;
      try {
        pairInfo = await gate.startPairing();
      } catch (e) {
        console.log(e);
      }
      return {gate, qrCode: pairInfo.qrCode};
    }

    const connectGateway = async (gate: HaloGateway) => {
      console.log('Waiting for smartphone to connect...');
      await gate.waitConnected();

      return gate;
    };

    const getCardAddress = async (gate: HaloGateway) => {
      let cmd = {
        "name": "get_pkeys",
      };
    
      const rawKeys = await gate.execHaloCmd(cmd);
      return rawKeys.etherAddresses['1'];
    };

    if (loadCard) {
      getGateway().then((output) => {
        console.log(output.qrCode);
        setCardQrCode(output.qrCode);

        connectGateway(output.gate).then((gate) => {
          getCardAddress(gate).then((cardAddress) => {
            setCardAddress(cardAddress);
            setLoadCard(false);
          });
        });
      });
    }
  }, [loadCard]);

  useEffect(() => {
    const fetchUsdAmountToSendAndVerifyOrder = async () => {
      const requestedUsdcAmount = currentQuote.requestedUSDC;
      const isValidRequestedUsdcAmount = requestedUsdcAmount && requestedUsdcAmount !== '0';

      if (getBestDepositForAmount && isValidRequestedUsdcAmount) {
        const indicativeQuote: IndicativeQuote = await getBestDepositForAmount(currentQuote.requestedUSDC);
        const usdAmountToSend = indicativeQuote.usdAmountToSend;
        const depositId = indicativeQuote.depositId;

        const isAmountToSendValid = usdAmountToSend !== undefined;
        const isDepositIdValid = depositId !== undefined;

        if (isAmountToSendValid && isDepositIdValid) {
          setCurrentQuote(prevState => ({
            ...prevState,
            fiatToSend: usdAmountToSend,
            depositId: depositId
          }));

          const doesNotHaveOpenIntent = currentIntentHash === null;
          if (doesNotHaveOpenIntent) {

            const lastOnRampTimestampLoaded = lastOnRampTimestamp !== null;
            const onRampCooldownPeriodLoaded = onRampCooldownPeriod !== null;
            if (lastOnRampTimestampLoaded && onRampCooldownPeriodLoaded) {
              const onRampCooldownEnd = (lastOnRampTimestamp + onRampCooldownPeriod) * 1000n;
              const onRampCooldownElapsed = Date.now() >= onRampCooldownEnd;

              if (!onRampCooldownElapsed) {
                updateQuoteErrorState(QuoteState.ORDER_COOLDOWN_PERIOD);
              } else if (parseFloat(usdAmountToSend) > VENMO_MAX_TRANSFER_SIZE) {
                updateQuoteErrorState(QuoteState.EXCEEDS_MAX_SIZE);
              } else {
                setQuoteState(QuoteState.SUCCESS);

                setShouldConfigureSignalIntentWrite(true);
              }
            }
          } else {
            updateQuoteErrorState(QuoteState.EXCEEDS_ORDER_COUNT);
          }
        } else {
          updateQuoteErrorState(QuoteState.INSUFFICIENT_LIQUIDITY);
          setCurrentQuote(prevState => ({
            ...prevState,
            fiatToSend: '',
            depositId: ZERO
          }));
        }
      } else {
        updateQuoteErrorState(QuoteState.DEFAULT);
        setCurrentQuote(prevState => ({
          ...prevState,
          fiatToSend: '',
          depositId: ZERO
        }));
      }
    };

    fetchUsdAmountToSendAndVerifyOrder();
  }, [
      currentQuote.requestedUSDC,
      getBestDepositForAmount,
      currentIntentHash,
      lastOnRampTimestamp,
      onRampCooldownPeriod,
    ]
  );

  /*
   * Handlers
   */

  const navigateToRegistrationHandler = () => {
    navigate('/register');
  };

  /*
   * Helpers
   */

  const updateQuoteErrorState = (error: any) => {
    console.log('updateQuoteErrorState: ', error)

    setQuoteState(error);

    setShouldConfigureSignalIntentWrite(false);
  }

  function isValidInput(value) {
    const isValid = /^-?\d*(\.\d{0,6})?$/.test(value);
    return !isNaN(value) && parseFloat(value) >= 0 && isValid;
  }

  const usdcBalanceLabel = useMemo(() => {
    if (isLoggedIn && usdcBalance !== null) {
      return `Balance: ${toUsdcString(usdcBalance)}`
    } else {
      return '';
    }
  }, [usdcBalance, isLoggedIn]);

  const getButtonText = () => {
    switch (quoteState) {
      case QuoteState.ORDER_COOLDOWN_PERIOD:
        return 'Order cooldown not elapsed';

      case QuoteState.EXCEEDS_ORDER_COUNT:
        return 'Max one open order';

      case QuoteState.EXCEEDS_MAX_SIZE:
        return 'Exceeded USD transfer limit of 2,000';

      case QuoteState.INSUFFICIENT_LIQUIDITY:
        return 'Insufficient liquidity';

      case QuoteState.DEFAULT:
        return 'Input USDC amount'

      case QuoteState.SUCCESS:
      default:
        return 'Start Order';
    }
  }

  /*
   * Component
   */

  return (
    <Wrapper>
      <SwapModalContainer>
        {!loadCard ? (
          <div>
            <TitleContainer>
              <ThemedText.HeadlineSmall>
                Swap
              </ThemedText.HeadlineSmall>
            </TitleContainer>
            <MainContentWrapper>
              <Input
                label="Requesting"
                name={`requestedUSDC`}
                value={currentQuote.requestedUSDC}
                onChange={event => handleInputChange(event, 'requestedUSDC')}
                type="number"
                inputLabel="USDC"
                accessoryLabel={usdcBalanceLabel}
                placeholder="0"
              />
              <Input
                label="You send"
                name={`fiatToSend`}
                value={currentQuote.fiatToSend}
                onChange={event => handleInputChange(event, 'fiatToSend')}
                onKeyDown={handleEnterPress}
                type="number"
                inputLabel="$"
                placeholder="0.00"
                accessoryLabel="via Venmo"
                readOnly={true}
              />
              {!isLoggedIn ? (
                <CustomConnectButton
                  fullWidth={true}
                />
              ) : (!isRegistered && currentQuote.requestedUSDC) ? (
                <Button
                  onClick={navigateToRegistrationHandler}
                >
                  Complete Registration
                </Button>
              ) : (
                <CTAButton
                  disabled={quoteState !== 'success'}
                  loading={isSubmitIntentLoading || isSubmitIntentMining}
                  onClick={async () => {
                    try {
                      await writeSubmitIntentAsync?.();
                    } catch (error) {
                      console.log('writeSubmitIntentAsync failed: ', error);
                    }
                  }}
                >
                  {getButtonText()}
                </CTAButton>
              )}
            </MainContentWrapper>
          </div>
        ) : (
          <div>
            <RowBetween>
              <div style={{ flex: 0.25 }}>
                <button
                  onClick={handleLoadCard}
                  style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  <StyledArrowLeft/>
                </button>
              </div>
              <ThemedText.HeadlineSmall style={{ flex: '1', margin: 'auto', textAlign: 'center' }}>
                Load Arx Wallet
              </ThemedText.HeadlineSmall>
              <div style={{ flex: 0.25 }}></div>
            </RowBetween>
            <LoadCardContainer>
              <p>Step 1: Scan QR code with your phone camera</p>
              <img
                id="qr"
                src={cardQrCode}
                alt="n/a"
              />
            </LoadCardContainer>
          </div>
        )
        }
      </SwapModalContainer>
      {(!loadCard && cardAddress == '') && (
        <CTAButton
          // loading={isSubmitIntentLoading || isSubmitIntentMining}
          onClick={handleLoadCard}
        >
          Load Arx Wallet
        </CTAButton>
      )}
      {cardAddress != '' && !currentIntentHash && (
        <SwapModalContainer>
          <ThemedText.HeadlineSmall style={{ flex: '1', margin: 'auto', textAlign: 'center', color: '#df2e2d' }}>
            Loading Card Address
          </ThemedText.HeadlineSmall>
          <div style={{textAlign: 'center'}}>{cardAddress}</div>
        </SwapModalContainer>
      )}
      {
        currentIntentHash && (
          <>
            <VerticalDivider />
            <OnRamperIntentTable
              onIntentRowClick={onIntentTableRowClick}
            />
          </>
        )
      }
    </Wrapper>
  );
};

const StyledArrowLeft = styled(ArrowLeft)`
  color: #FFF;
`;

const RowBetween = styled.div`
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1.5rem;
`;

const LoadCardContainer = styled.div`
  padding: 1.5rem;
  display: flex;
  background-color: #0D111C;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  align-items: center;
  flex-direction: column;
  justify-content: center;
`;

const Wrapper = styled.div`
  width: 100%;
  max-width: 484px;
  margin-top: 50px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const SwapModalContainer = styled(AutoColumn)`
  border-radius: 16px;
  border: 1px solid #DEE2E6;
  padding: 1rem;
  gap: 1rem;
  background-color: #0D111C;
  border: 1px solid #98a1c03d;
  box-shadow: 0px 2px 8px 0px rgba(0, 0, 0, 0.25);
`;

const TitleContainer = styled.div`
  display: flex;
  margin-left: 0.75rem;
`;

const MainContentWrapper = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-self: center;
  border-radius: 4px;
  justify-content: center;
`;

const CTAButton = styled(Button)`
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px !important;
  padding: 1rem;
  font-size: 20px;
  font-weight: 550;
  transition: all 75ms;
`;

const VerticalDivider = styled.div`
  height: 32px;
  border-left: 1px solid #98a1c03d;
  margin: 0 auto;
`;

export default Swap;
