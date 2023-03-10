const { network, ethers } = require("hardhat")
const { networkConfig, developmentChains, VERIFICATION_BLOCK_CONFIRMATIONS } = require("../helper-hardhat-config")
const { vrfCoordinatorV2Interface_abi, linkTokenInterface_abi } = require("../utils/constants.js")
const { verify } = require("../utils/verify")

const FUND_AMOUNT = ethers.utils.parseEther("1") // 1 Ether
const LINK_FUND_AMOUNT = ethers.utils.parseEther("1") // 1 LINK

module.exports = async ({ getNamedAccounts, deployments }) => {
    const { deploy, log } = deployments
    const { deployer } = await getNamedAccounts()
    const chainId = network.config.chainId
    let vrfCoordinatorV2, vrfCoordinatorV2Address, subscriptionId, vrfCoordinatorV2Mock, raffleExists, raffle
    const waitBlockConfirmations = developmentChains.includes(network.name) ? 1 : VERIFICATION_BLOCK_CONFIRMATIONS

    // Local Network \\
    if (chainId == 31337) {
        log("Local Network Detected!")
        // Creating VRFV2 Subscription
        log("Creating VRFV2 Subscription...")
        vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock")
        vrfCoordinatorV2Address = vrfCoordinatorV2Mock.address
        const transactionResponse = await vrfCoordinatorV2Mock.createSubscription()
        const transactionReceipt = await transactionResponse.wait()
        subscriptionId = transactionReceipt.events[0].args.subId
        log(`Subscription Id: ${subscriptionId}`)
        // Funding The Subscription
        // Our Mock Makes It, So We Don't Actually Have To Worry About Sending Fund
        await vrfCoordinatorV2Mock.fundSubscription(subscriptionId, FUND_AMOUNT)
    }
    // Goerli Network \\
    else {
        vrfCoordinatorV2Address = networkConfig[chainId]["vrfCoordinatorV2"]
        const [signer] = await ethers.getSigners()
        //const signer = await ethers.getSigner(deployer)
        log(`Signer: ${signer.address}`)
        vrfCoordinatorV2 = new ethers.Contract(vrfCoordinatorV2Address, vrfCoordinatorV2Interface_abi, signer)
        subscriptionId = networkConfig[chainId]["subscriptionId"]

        // If SubscriptionId doesn't exists -> create subscription
        if (subscriptionId == 0) {
            log("Creating VRFV2 Subscription...")
            const transactionResponse = await vrfCoordinatorV2.createSubscription()
            const transactionReceipt = await transactionResponse.wait()
            subscriptionId = transactionReceipt.events[0].args.subId
        }
        log(`Subscription Id: ${subscriptionId}`)

        // Checking Subscription Balance...
        log(`Checking Subscription Balance...`)
        const getSub = await vrfCoordinatorV2.getSubscription(subscriptionId)
        const { 0: balance, 1: reqCount, 2: owner, 3: consumers } = getSub
        const correctedBal = balance / 10e17
        log(`Subscription Balance Is: ${correctedBal} LINK`)

        // Funding Subscription If Balance Is < 1 LINK
        if (correctedBal < 1) {
            log(`Funding Subscription...`)
            // "parseInt()" transforms the string to a integer or simply pass the integer.
            // "ethers.utils.hexlify" transforms the integer to a HextString
            // "ethers.utils.hexZeroPad" will add the necessary amount of zeros to make the value have the correct length in this case 32
            const formattedSubId = ethers.utils.hexZeroPad(ethers.utils.hexlify(parseInt(subscriptionId)), 32)
            log(`Formatted SubId: ${formattedSubId}`)
            const linkContractAddress = networkConfig[chainId]["linkToken"]
            linkContract = new ethers.Contract(linkContractAddress, linkTokenInterface_abi, signer)
            const fundSubTxResponse = await linkContract.transferAndCall(vrfCoordinatorV2Address, LINK_FUND_AMOUNT, formattedSubId, {
                from: deployer,
            })
            await fundSubTxResponse.wait()
            const getBal = await vrfCoordinatorV2.getSubscription(subscriptionId)
            const { 0: balance, 1: reqCount, 2: owner, 3: consumer } = getBal
            const corrBal = balance / 10e17
            log(`Funding Completed Successfully!`)
            log(`Updated Subscription Balance Is: ${corrBal}`)
        }
    }

    log("----------------------------------------------------")

    const arguments = [
        vrfCoordinatorV2Address,
        subscriptionId,
        networkConfig[chainId]["gasLane"],
        networkConfig[chainId]["keepersUpdateInterval"],
        networkConfig[chainId]["raffleEntranceFee"],
        networkConfig[chainId]["callbackGasLimit"],
    ]

    // Checking If Raffle Already Exists...
    if (!developmentChains.includes(network.name)) {
        try {
            log(`Checking If Raffle Already Exists...`)
            raffle = await deployments.get("Raffle")
            log(`Raffle Already Exists: ${raffle.address}`)
        } catch (error) {
            log(`Raffle Doesn't Exists`)
            raffleExists = false
        }
    }

    if (developmentChains.includes(network.name) || raffleExists == false) {
        raffle = await deploy("Raffle", {
            from: deployer,
            args: arguments,
            log: true,
            waitConfirmations: waitBlockConfirmations,
        })
    }
    log(`Raffle Contract Deployed At: ${raffle.address}`)

    // Ensure the Raffle contract is a valid consumer of the VRFCoordinatorV2Mock contract.
    if (developmentChains.includes(network.name)) {
        log(`Adding Consumer...`)
        const vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock")
        await vrfCoordinatorV2Mock.addConsumer(subscriptionId, raffle.address)
        log(`Consumer Successfully Added!`)
    }
    // Checking If Deployed Raffle Is Added To Consumer List...
    // Adding Raffle Contract To Consumer List If It Is Not...
    else {
        const getConsumers = await vrfCoordinatorV2.getSubscription(subscriptionId)
        const { 0: balance, 1: reqCount, 2: owner, 3: consumers } = getConsumers
        log(`Consumers: ${consumers}`)
        if (!consumers.includes(raffle.address)) {
            log(`Adding Consumer...`)
            const addConsumerTxResponse = await vrfCoordinatorV2.addConsumer(subscriptionId, raffle.address)
            await addConsumerTxResponse.wait()
            const getConsumer = await vrfCoordinatorV2.getSubscription(subscriptionId)
            const { 0: balance, 1: reqCount, 2: owner, 3: consumer } = getConsumer
            log(`Consumer Successfully Added! Consumers: ${consumer}`)
        }
    }

    // Verify the deployment
    if (!developmentChains.includes(network.name) && process.env.ETHERSCAN_API_KEY) {
        log(`Verifying Raffle Contract... ${raffle.address}`)
        await verify(raffle.address, arguments)
    }

    // log("Enter lottery with command:")
    // const networkName = network.name == "hardhat" ? "localhost" : network.name
    // log(`yarn hardhat run scripts/enterRaffle.js --network ${networkName}`)
    // log("----------------------------------------------------")
}

module.exports.tags = ["all", "raffle"]
