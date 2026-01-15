
let username = ""; // ✅ Stores the player's username
let password = ""; // ✅ Stores the player's password

let lobbyUserColors = {}; // Maps username -> assigned color for lobby session
let mainRoomUserColors = {}; // Maps username -> assigned color for main room session

// ✅ Function to Show the Sign-In Screen
function clearUI() {
    let uiElements = document.querySelectorAll(".ui-element"); // ✅ Select all UI elements
    uiElements.forEach(el => el.remove()); // ✅ Remove only UI elements
}
function clearAllDomElements() {
    const tagsToRemove = ["div", "input", "button", "textarea", "img", "canvas"];

    tagsToRemove.forEach(tag => {
        document.querySelectorAll(tag).forEach(el => {
            if (!el.classList.contains("phaser-vignette") && el !== document.querySelector("canvas")) {
                el.remove();
            }
        });
    });

    console.log("🧹 DOM elements cleared.");
}
function removeAllVignettes() {
    console.log("🗑 Removing all vignettes...");

    let vignettes = document.querySelectorAll(".vignette"); // ✅ Select all vignettes
    vignettes.forEach(vignette => vignette.remove()); // ✅ Remove them

    console.log("✅ All vignettes removed.");
}
function showSignInScreen() {
    console.log("🔑 Showing sign-in screen...");

    // ✅ Create sign-in container
    let signInVignette = document.createElement("div");
    signInVignette.id = "SignInVignette"; // ID for removal
    signInVignette.classList.add("vignette"); // ✅ Add a class for easy removal
    signInVignette.style.position = "fixed";
    signInVignette.style.top = "0";
    signInVignette.style.left = "0";
    signInVignette.style.width = "100vw";
    signInVignette.style.height = "100vh";
    signInVignette.style.pointerEvents = "none"; // ✅ Allows interaction with UI elements underneath
    signInVignette.style.background = "radial-gradient(circle, rgba(34, 139, 34, 1) 30%, rgba(0, 0, 0, 1) 100%)";
    signInVignette.style.zIndex = "50";
    document.body.appendChild(signInVignette); 

    let signInContainer = document.createElement("div");
    signInContainer.id = "signInContainer";
    signInContainer.style.position = "absolute";
    signInContainer.style.top = "0";
    signInContainer.style.left = "0";
    signInContainer.style.width = "100vw";
    signInContainer.style.height = "100vh";
    signInContainer.style.background = "none";
    signInContainer.style.border = "none";
    signInContainer.style.display = "flex";
    signInContainer.style.flexDirection = "column";
    signInContainer.style.justifyContent = "center";
    signInContainer.style.alignItems = "center";
    signInContainer.style.color = "white";
    signInContainer.style.fontSize = "24px";
    signInContainer.style.zIndex = "100";
    let logo = document.createElement("img");
    logo.src = "assets/logo.png"; // ✅ Path to your logo image
    logo.alt = "Game Logo";
    logo.style.width = "26vw"; // ✅ Adjust size as needed
    logo.style.marginBottom = "2vh";
    logo.style.position = "relative";
    logo.style.left = "2vw"
    signInContainer.appendChild(logo); 
    // ✅ Username Input
    let usernameInput = document.createElement("input");
    usernameInput.type = "text";
    usernameInput.placeholder = "Username";
    usernameInput.style.fontSize = "12px";
    usernameInput.style.padding = "10px";
    usernameInput.style.marginBottom = "10px";
    usernameInput.style.borderRadius = "5px";
    usernameInput.style.border = "none";
    usernameInput.style.textAlign = "center";
    signInContainer.appendChild(usernameInput);

    // ✅ Password Input
    let passwordInput = document.createElement("input");
    passwordInput.type = "password"; // ✅ Password type hides input
    passwordInput.placeholder = "Password";
    passwordInput.style.fontSize = "12px";
    passwordInput.style.padding = "10px";
    passwordInput.style.marginBottom = "10px";
    passwordInput.style.borderRadius = "5px";
    passwordInput.style.border = "none";
    passwordInput.style.textAlign = "center";
    signInContainer.appendChild(passwordInput);

    // ✅ Sign In Button
    let signInButton = document.createElement("button");
    signInButton.innerText = "Sign In";
    signInButton.style.fontSize = "14px";
    signInButton.style.padding = "10px 20px";
    signInButton.style.borderRadius = "5px";
    signInButton.style.border = "none";
    signInButton.style.background = "#23782d";
    signInButton.style.color = "#fff";
    signInButton.style.cursor = "pointer";

    signInButton.onclick = () => {
        username = usernameInput.value.trim();
        password = passwordInput.value.trim();

        if (username.length === 0 || password.length === 0) {
            alert("Please enter both a username and a password.");
            return;
        }

        console.log(`📡 Signing in as: ${username}`);

        // ✅ Send sign-in data to the server
        socket.emit("signIn", { username, password });
    };

    signInContainer.appendChild(signInButton);

    // Divider with "or" text
    let divider = document.createElement("div");
    divider.style.display = "flex";
    divider.style.alignItems = "center";
    divider.style.width = "80%";
    divider.style.margin = "15px 0 10px 0";
    divider.innerHTML = `
        <div style="flex: 1; height: 1px; background: rgba(255,255,255,0.3);"></div>
        <span style="padding: 0 10px; color: rgba(255,255,255,0.7); font-size: 12px;">New user?</span>
        <div style="flex: 1; height: 1px; background: rgba(255,255,255,0.3);"></div>
    `;
    signInContainer.appendChild(divider);

    let signUpButton = document.createElement("button");
    signUpButton.innerText = "Create Account";
    signUpButton.style.fontSize = "14px";
    signUpButton.style.padding = "10px 20px";
    signUpButton.style.borderRadius = "5px";
    signUpButton.style.border = "none";
    signUpButton.style.background = "#007bff";
    signUpButton.style.color = "#fff";
    signUpButton.style.cursor = "pointer";

    signUpButton.onclick = showRegisterScreen;
    signInContainer.appendChild(signUpButton);

    // Enter key to submit on any input field
    const handleEnterKey = (e) => {
        if (e.key === 'Enter') {
            signInButton.click();
        }
    };
    usernameInput.addEventListener('keypress', handleEnterKey);
    passwordInput.addEventListener('keypress', handleEnterKey);

    document.body.appendChild(signInContainer);
}
function showRegisterScreen(){
    // Capture values from sign-in form before removing it
    let existingContainer = document.getElementById("signInContainer");
    let existingUsername = "";
    let existingPassword = "";
    if (existingContainer) {
        let existingUsernameInput = existingContainer.querySelector('input[type="text"]');
        let existingPasswordInput = existingContainer.querySelector('input[type="password"]');
        if (existingUsernameInput) existingUsername = existingUsernameInput.value;
        if (existingPasswordInput) existingPassword = existingPasswordInput.value;
        existingContainer.remove();
    }

    // Remove old vignette if exists
    let oldVignette = document.getElementById("SignInVignette");
    if (oldVignette) oldVignette.remove();

    let registerVignette = document.createElement("div");
    registerVignette.id = "RegisterVignette";
    registerVignette.classList.add("vignette");
    registerVignette.style.position = "fixed";
    registerVignette.style.top = "0";
    registerVignette.style.left = "0";
    registerVignette.style.width = "100vw";
    registerVignette.style.height = "100vh";
    registerVignette.style.pointerEvents = "none";
    registerVignette.style.background = "radial-gradient(circle, rgba(34, 139, 34, 1) 30%, rgba(0, 0, 0, 1) 100%)";
    registerVignette.style.zIndex = "50";
    document.body.appendChild(registerVignette);

    let registerContainer = document.createElement("div");
    registerContainer.id = "registerContainer";
    registerContainer.style.position = "absolute";
    registerContainer.style.top = "0";
    registerContainer.style.left = "0";
    registerContainer.style.width = "100vw";
    registerContainer.style.height = "100vh";
    registerContainer.style.background = "none";
    registerContainer.style.border = "none";
    registerContainer.style.display = "flex";
    registerContainer.style.flexDirection = "column";
    registerContainer.style.justifyContent = "center";
    registerContainer.style.alignItems = "center";
    registerContainer.style.color = "white";
    registerContainer.style.fontSize = "24px";
    registerContainer.style.zIndex = "100";
    let logo = document.createElement("img");
    logo.src = "assets/logo.png";
    logo.alt = "Game Logo";
    logo.style.width = "26vw";
    logo.style.marginBottom = "2vh";
    logo.style.position = "relative";
    logo.style.left = "2vw"
    registerContainer.appendChild(logo);

    // Username Input - pre-fill with value from sign-in form
    let usernameInput = document.createElement("input");
    usernameInput.type = "text";
    usernameInput.placeholder = "Username";
    usernameInput.value = existingUsername;
    usernameInput.style.fontSize = "12px";
    usernameInput.style.padding = "10px";
    usernameInput.style.marginBottom = "10px";
    usernameInput.style.borderRadius = "5px";
    usernameInput.style.border = "none";
    usernameInput.style.textAlign = "center";
    registerContainer.appendChild(usernameInput);

    // Password Input - pre-fill with value from sign-in form
    let passwordInput = document.createElement("input");
    passwordInput.type = "password";
    passwordInput.placeholder = "Password";
    passwordInput.value = existingPassword;
    passwordInput.style.fontSize = "12px";
    passwordInput.style.padding = "10px";
    passwordInput.style.marginBottom = "10px";
    passwordInput.style.borderRadius = "5px";
    passwordInput.style.border = "none";
    passwordInput.style.textAlign = "center";
    registerContainer.appendChild(passwordInput);

    let confirmPasswordInput = document.createElement("input");
    confirmPasswordInput.type = "password"; // ✅ Password type hides input
    confirmPasswordInput.placeholder = "confirm password";
    confirmPasswordInput.style.fontSize = "12px";
    confirmPasswordInput.style.padding = "10px";
    confirmPasswordInput.style.marginBottom = "10px";
    confirmPasswordInput.style.borderRadius = "5px";
    confirmPasswordInput.style.border = "none";
    confirmPasswordInput.style.textAlign = "center";
    registerContainer.appendChild(confirmPasswordInput);

    let registerButton = document.createElement("button");
    registerButton.innerText = "Register";
    registerButton.style.fontSize = "14px";
    registerButton.style.padding = "10px 20px";
    registerButton.style.borderRadius = "5px";
    registerButton.style.border = "none";
    registerButton.style.background = "#23782d";
    registerButton.style.color = "#fff";
    registerButton.style.cursor = "pointer";

    registerButton.onclick = () =>  {
        let username = usernameInput.value.trim();
        let password = passwordInput.value.trim();
        let confirmPassword = confirmPasswordInput.value.trim();
    
        if (username === "" || password === "" || confirmPassword === "") {
            alert("❌ Please fill out all fields.");
            return;
        }
    
        if (password !== confirmPassword) {
            alert("❌ Passwords do not match!");
            return;
        }
    
        console.log(`📡 Registering user: ${username}`);
        socket.emit("signUp", { username, password });
        showSignInScreen();
    }
    registerContainer.appendChild(registerButton);

    // Back to Sign In button
    let backButton = document.createElement("button");
    backButton.innerText = "Back to Sign In";
    backButton.style.fontSize = "14px";
    backButton.style.padding = "10px 20px";
    backButton.style.borderRadius = "5px";
    backButton.style.border = "none";
    backButton.style.background = "#6b7280";
    backButton.style.color = "#fff";
    backButton.style.cursor = "pointer";
    backButton.style.marginTop = "10px";
    backButton.onclick = () => {
        // Clean up register screen
        let regContainer = document.getElementById("registerContainer");
        if (regContainer) regContainer.remove();
        let regVignette = document.getElementById("RegisterVignette");
        if (regVignette) regVignette.remove();
        // Show sign-in screen
        showSignInScreen();
    };
    registerContainer.appendChild(backButton);

    // Enter key to submit on any input field
    const handleEnterKey = (e) => {
        if (e.key === 'Enter') {
            registerButton.click();
        }
    };
    usernameInput.addEventListener('keypress', handleEnterKey);
    passwordInput.addEventListener('keypress', handleEnterKey);
    confirmPasswordInput.addEventListener('keypress', handleEnterKey);

    document.body.appendChild(registerContainer);
}
socket.on("signInResponse", (data) => {
    if (data.success) {
        console.log(`Sign-in successful: ${username}`);
        sessionStorage.setItem("username", username);
        // Clear sign-in UI
        clearUI();
        let signInContainer = document.getElementById("signInContainer");
        if (signInContainer) signInContainer.remove();
        let signInVignette = document.getElementById("SignInVignette");
        if (signInVignette) signInVignette.remove();

        // Check if user has an active game to rejoin
        if (data.activeGameId) {
            console.log(`Active game found: ${data.activeGameId}, attempting to rejoin...`);
            sessionStorage.setItem("gameId", data.activeGameId);
            socket.emit("rejoinGame", { gameId: data.activeGameId, username: username });
        } else {
            // Go to main room
            socket.emit("joinMainRoom");
        }
    } else {
        alert("Sign-in failed! Incorrect username or password.");
    }
});
// Listen for Sign-Up Response
socket.on("signUpResponse", (data) => {
    if (data.success) {
        if (data.autoLoggedIn) {
            // Auto-login: go straight to main room
            console.log(`Registration & auto-login successful: ${data.username}`);
            username = data.username;  // Update global username
            sessionStorage.setItem("username", data.username);
            // Clear sign-in UI
            clearUI();
            let signInContainer = document.getElementById("signInContainer");
            if (signInContainer) signInContainer.remove();
            let signInVignette = document.getElementById("SignInVignette");
            if (signInVignette) signInVignette.remove();
            socket.emit("joinMainRoom"); // Go to main room
        } else {
            alert("Registration successful! Please sign in.");
        }
    } else {
        alert(`Registration failed: ${data.message}`);
    }
});
// ✅ Function to Handle Sign-In Response

function showScore(teamScore, opponentScore, bidArray, team1Tricks, team2Tricks, team1OldScore, team2OldScore) {
    console.log("📢 Adding score to game log...");

    // Get player names
    let teamName = playerData.username[playerData.position.indexOf(position)].username + "/" + playerData.username[playerData.position.indexOf(team(position))].username;
    let oppName = playerData.username[playerData.position.indexOf(rotate(position))].username + "/" + playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))].username;

    // Get bid indices based on player's position (position is 1-indexed, array is 0-indexed)
    let myBidIdx = position - 1;
    let partnerBidIdx = team(position) - 1;
    let opp1BidIdx = rotate(position) - 1;
    let opp2BidIdx = rotate(rotate(rotate(position))) - 1;

    // Calculate score changes
    let teamChange = teamScore - team1OldScore;
    let oppChange = opponentScore - team2OldScore;
    let teamChangeStr = teamChange >= 0 ? "+" + teamChange : teamChange.toString();
    let oppChangeStr = oppChange >= 0 ? "+" + oppChange : oppChange.toString();

    // Add to game log
    addToGameFeed("--- HAND COMPLETE ---");
    addToGameFeed(`${teamName}: Bid ${bidArray[myBidIdx]}/${bidArray[partnerBidIdx]}, Won ${team1Tricks}, ${teamChangeStr} → ${teamScore}`);
    addToGameFeed(`${oppName}: Bid ${bidArray[opp1BidIdx]}/${bidArray[opp2BidIdx]}, Won ${team2Tricks}, ${oppChangeStr} → ${opponentScore}`);

    // Update the score display in the game log header
    updateGameLogScore(teamName, oppName, teamScore, opponentScore);
}
function showLobbyScreen() {
    clearUI();
    console.log("🎮 Showing lobby screen...");
    signInVignette = document.getElementById("SignInVignette");
    if(signInVignette) signInVignette.remove();
    let signInContainer = document.getElementById("signInContainer");
    if (signInContainer) signInContainer.remove();
    // ✅ Create the lobby container
    let lobbyVignette = document.createElement("div");
    lobbyVignette.classList.add("vignette"); // ✅ Add a class for easy removal
    lobbyVignette.style.position = "fixed";
    lobbyVignette.style.top = "0";
    lobbyVignette.style.left = "0";
    lobbyVignette.style.width = "100vw";
    lobbyVignette.style.height = "100vh";
    lobbyVignette.style.pointerEvents = "none"; // ✅ Allows interaction with UI elements underneath
    lobbyVignette.style.background = "radial-gradient(circle, rgba(34, 139, 34, 1) 30%, rgba(0, 0, 0, 1) 100%)";
    document.body.appendChild(lobbyVignette); 

    let lobbyContainer = document.createElement("div");
    lobbyContainer.id = "lobbyContainer";
    lobbyContainer.style.position = "absolute";
    lobbyContainer.style.top = "60%";
    lobbyContainer.style.left = "50%";
    lobbyContainer.style.width = "30vw";
    lobbyContainer.style.height = "75vh";
    lobbyContainer.style.transform = "translate(-50%, -50%)"; // ✅ Center properly
    lobbyContainer.style.borderRadius = "10px"; // ✅ Rounded corners
    lobbyContainer.style.background = "#222"; // Dark background
    lobbyContainer.style.border = "none";
    lobbyContainer.style.display = "flex";
    lobbyContainer.style.flexDirection = "column";
    lobbyContainer.style.justifyContent = "center";
    lobbyContainer.style.alignItems = "center";
    lobbyContainer.style.color = "white";
    lobbyContainer.style.fontSize = "24px";


    // ✅ Play Button (goes to main room)
    let joinButton = document.createElement("button");
    joinButton.innerText = "Play";
    joinButton.style.fontSize = "20px";
    joinButton.style.padding = "10px 20px";
    joinButton.style.borderRadius = "5px";
    joinButton.style.border = "none";
    joinButton.style.background = "#28a745";
    joinButton.style.color = "#fff";
    joinButton.style.cursor = "pointer";

    joinButton.onclick = () => {
        console.log("📡 Joining main room...");
        socket.emit("joinMainRoom"); // Go to main room
    };
    // ✅ Append elements to body
    lobbyContainer.appendChild(joinButton);
    let signOutButton = document.createElement("button");
    signOutButton.innerText = "Sign Out";
    signOutButton.style.fontSize = "18px";
    signOutButton.style.padding = "10px 20px";
    signOutButton.style.borderRadius = "5px";
    signOutButton.style.border = "none";
    signOutButton.style.background = "rgb(217, 83, 79)"; // ✅ Red color for sign out
    signOutButton.style.color = "white";
    signOutButton.style.cursor = "pointer";
    signOutButton.style.position = "absolute";
    signOutButton.style.bottom = "10px"; // ✅ Move to bottom
    signOutButton.style.left = "10px"; // ✅ Move to left
    signOutButton.onclick = signOut; // ✅ Hook up sign-out functionality
    lobbyContainer.appendChild(signOutButton);

    let logo = document.createElement("img");
    logo.src = "assets/logo.png"; // ✅ Path to your logo image
    logo.alt = "Game Logo";
    logo.classList.add("ui-element"); // ✅ Mark it for removal
    logo.style.width = "11vw"; // ✅ Adjust size as needed
    logo.style.position = "absolute";
    logo.style.top = "10%"; // ✅ Position above the lobby container
    logo.style.left = "50%";
    logo.style.transform = "translateX(-50%)"; // ✅ Center horizontally
    logo.style.zIndex = "1001"; // ✅ Ensure it's above the vignette

    document.body.appendChild(logo);
    document.body.appendChild(lobbyContainer);
}
function removeLobbyScreen(){
    console.log("🏢 Removing lobby screen...");
    let lobbyContainer = document.getElementById("lobbyContainer");
    if (lobbyContainer) lobbyContainer.remove(); // ✅ Remove lobby container
    let lobbyVignette = document.getElementById("lobbyVignette");
    if (lobbyVignette) lobbyVignette.remove(); // ✅ Remove lobby vignette
    let logo = document.querySelector("img[src='assets/logo.png']"); // ✅ Select the logo by its source
    if (logo) logo.remove(); // ✅ Remove the logo
}
function showPlayerQueue(currentUsers) {
    console.log("inside of SPQ, currentUsers: ", currentUsers);
    let oldContainer = document.getElementById("queueContainer");
    if (oldContainer) oldContainer.remove();

    // Create container
    const container = document.createElement("div");
    container.id = "queueContainer";
    container.style.position = "absolute";
    container.style.top = "50%";
    container.style.left = "50%";
    container.style.transform = "translate(-50%, -50%)";
    container.style.background = "rgba(34, 34, 34, 0.9)";
    container.style.color = "#fff";
    container.style.padding = "30px";
    container.style.borderRadius = "10px";
    container.style.border = "3px solid #888";
    container.style.fontSize = "20px";
    container.style.fontFamily = "Arial, sans-serif";
    container.style.minWidth = "16vw";
    container.style.textAlign = "center";
    container.style.zIndex = 1000;

    // Add heading
    const heading = document.createElement("div");
    heading.innerText = "Waiting for players...";
    heading.style.fontSize = "24px";
    heading.style.marginBottom = "20px";
    container.appendChild(heading);

    // Add usernames
    console.log("currentUsers: ", currentUsers);
    console.log("length of currentUsers: ", currentUsers.length);
    for(let i=0; i < currentUsers.length; i++){
        console.log("trying to add: ", currentUsers[i].username);
        const nameLine = document.createElement("div");
        nameLine.innerText = `${i + 1}. ${currentUsers[i].username}`;
        nameLine.style.marginBottom = "10px";
        container.appendChild(nameLine);
   }
    // Add to body
    document.body.appendChild(container);
}
function removePlayerQueue() {
    const queueContainer = document.getElementById("queueContainer");
    if (queueContainer) {
        queueContainer.remove();
        console.log("🗑 Player queue removed.");
    }
}
function signOut() {
    console.log("🚪 Signing out...");
    sessionStorage.removeItem("username"); // ✅ Clear stored username
    showSignInScreen(); // ✅ Return to sign-in page
}
// ✅ Function to Show Waiting Screen
function showWaitingScreen() {
    waitBool = true;
    console.log("⌛ Showing waiting screen...");
    removeLobbyScreen();
    if(queueDelay){
        showPlayerQueue(queueDelay);
    }
}

// ✅ Function to Remove Waiting Screen (Start Game)
function removeWaitingScreen() {
    let waitingContainer = document.getElementById("waitingContainer");
    if (waitingContainer) waitingContainer.remove();
    let waitingVignette = document.getElementById("waitingVignette");
    if (waitingVignette) waitingVignette.remove();
    let lobbyContainer = document.getElementById("lobbyContainer");
    if (lobbyContainer) lobbyContainer.remove();
    removeAllVignettes();
    clearUI();
    removePlayerQueue();
    removeGameLobby();
    waitBool = false;
    console.log("🚀 Game starting...");
}

// ==================== MAIN ROOM (Global Chat + Lobby Browser) ====================

function showMainRoom(data) {
    console.log("🏠 Showing main room...", data);

    // Remove any existing UI
    removeMainRoom();
    removePlayerQueue();
    removeGameLobby();

    // Fresh color assignments for new main room session
    mainRoomUserColors = {};

    // Create main container
    const container = document.createElement("div");
    container.id = "mainRoomContainer";
    container.style.position = "fixed";
    container.style.top = "50%";
    container.style.left = "50%";
    container.style.transform = "translate(-50%, -50%)";
    container.style.background = "rgba(26, 26, 46, 0.95)";
    container.style.color = "#fff";
    container.style.padding = "30px";
    container.style.borderRadius = "12px";
    container.style.border = "2px solid #4a5568";
    container.style.fontSize = "16px";
    container.style.width = "800px";
    container.style.maxWidth = "95vw";
    container.style.height = "600px";
    container.style.maxHeight = "90vh";
    container.style.boxSizing = "border-box";
    container.style.fontFamily = "Arial, sans-serif";
    container.style.zIndex = "1000";
    container.style.display = "flex";
    container.style.flexDirection = "column";

    // Header row
    const headerRow = document.createElement("div");
    headerRow.style.display = "flex";
    headerRow.style.justifyContent = "space-between";
    headerRow.style.alignItems = "center";
    headerRow.style.marginBottom = "20px";

    const header = document.createElement("div");
    header.innerText = "BAB Online";
    header.style.fontSize = "28px";
    header.style.fontWeight = "bold";
    header.style.color = "#4ade80";
    headerRow.appendChild(header);

    const onlineCount = document.createElement("div");
    onlineCount.id = "mainRoomOnlineCount";
    onlineCount.innerText = `${data.onlineCount || 0} players online`;
    onlineCount.style.fontSize = "14px";
    onlineCount.style.color = "#9ca3af";
    headerRow.appendChild(onlineCount);

    container.appendChild(headerRow);

    // Main content area (two panels)
    const contentArea = document.createElement("div");
    contentArea.style.display = "flex";
    contentArea.style.gap = "20px";
    contentArea.style.flex = "1";
    contentArea.style.minHeight = "0";
    contentArea.style.overflow = "hidden";

    // Left panel - Global Chat (60%)
    const chatPanel = document.createElement("div");
    chatPanel.style.flex = "1.4";
    chatPanel.style.display = "flex";
    chatPanel.style.flexDirection = "column";
    chatPanel.style.background = "rgba(0, 0, 0, 0.3)";
    chatPanel.style.borderRadius = "8px";
    chatPanel.style.padding = "15px";
    chatPanel.style.minHeight = "0";

    const chatHeader = document.createElement("div");
    chatHeader.innerText = "Global Chat";
    chatHeader.style.fontSize = "18px";
    chatHeader.style.fontWeight = "bold";
    chatHeader.style.marginBottom = "10px";
    chatHeader.style.color = "#60a5fa";
    chatPanel.appendChild(chatHeader);

    const chatMessages = document.createElement("div");
    chatMessages.id = "mainRoomChatMessages";
    chatMessages.style.flex = "1";
    chatMessages.style.overflowY = "auto";
    chatMessages.style.overflowX = "hidden";
    chatMessages.style.background = "rgba(0, 0, 0, 0.4)";
    chatMessages.style.borderRadius = "6px";
    chatMessages.style.padding = "10px";
    chatMessages.style.marginBottom = "10px";
    chatMessages.style.fontSize = "14px";
    chatMessages.style.wordBreak = "break-word";

    // Add existing messages
    if (data.messages && data.messages.length > 0) {
        data.messages.forEach(msg => {
            const msgDiv = createChatMessageElement(msg.username, msg.message);
            chatMessages.appendChild(msgDiv);
        });
        setTimeout(() => { chatMessages.scrollTop = chatMessages.scrollHeight; }, 0);
    }
    chatPanel.appendChild(chatMessages);

    // Chat input row
    const chatInputRow = document.createElement("div");
    chatInputRow.style.display = "flex";
    chatInputRow.style.gap = "10px";

    const chatInput = document.createElement("input");
    chatInput.id = "mainRoomChatInput";
    chatInput.type = "text";
    chatInput.placeholder = "Type a message...";
    chatInput.style.flex = "1";
    chatInput.style.padding = "10px";
    chatInput.style.borderRadius = "6px";
    chatInput.style.border = "1px solid #4a5568";
    chatInput.style.background = "#2d3748";
    chatInput.style.color = "#fff";
    chatInput.style.fontSize = "14px";
    chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && chatInput.value.trim()) {
            socket.emit("mainRoomChat", { message: chatInput.value.trim() });
            chatInput.value = "";
        }
    });
    chatInputRow.appendChild(chatInput);

    const sendBtn = document.createElement("button");
    sendBtn.innerText = "Send";
    sendBtn.style.padding = "10px 20px";
    sendBtn.style.borderRadius = "6px";
    sendBtn.style.border = "none";
    sendBtn.style.background = "#3b82f6";
    sendBtn.style.color = "#fff";
    sendBtn.style.cursor = "pointer";
    sendBtn.addEventListener("click", () => {
        if (chatInput.value.trim()) {
            socket.emit("mainRoomChat", { message: chatInput.value.trim() });
            chatInput.value = "";
        }
    });
    chatInputRow.appendChild(sendBtn);
    chatPanel.appendChild(chatInputRow);

    contentArea.appendChild(chatPanel);

    // Right panel - Lobby Browser (40%)
    const lobbyPanel = document.createElement("div");
    lobbyPanel.style.flex = "1";
    lobbyPanel.style.display = "flex";
    lobbyPanel.style.flexDirection = "column";
    lobbyPanel.style.background = "rgba(0, 0, 0, 0.3)";
    lobbyPanel.style.borderRadius = "8px";
    lobbyPanel.style.padding = "15px";
    lobbyPanel.style.minHeight = "0";

    const lobbyHeader = document.createElement("div");
    lobbyHeader.innerText = "Game Lobbies";
    lobbyHeader.style.fontSize = "18px";
    lobbyHeader.style.fontWeight = "bold";
    lobbyHeader.style.marginBottom = "10px";
    lobbyHeader.style.color = "#4ade80";
    lobbyPanel.appendChild(lobbyHeader);

    // Create Game button
    const createGameBtn = document.createElement("button");
    createGameBtn.innerText = "+ Create Game";
    createGameBtn.style.width = "100%";
    createGameBtn.style.padding = "12px";
    createGameBtn.style.marginBottom = "15px";
    createGameBtn.style.borderRadius = "6px";
    createGameBtn.style.border = "none";
    createGameBtn.style.background = "#4ade80";
    createGameBtn.style.color = "#000";
    createGameBtn.style.fontSize = "16px";
    createGameBtn.style.fontWeight = "bold";
    createGameBtn.style.cursor = "pointer";
    createGameBtn.addEventListener("click", () => {
        socket.emit("createLobby", {});
    });
    createGameBtn.addEventListener("mouseenter", () => {
        createGameBtn.style.background = "#22c55e";
    });
    createGameBtn.addEventListener("mouseleave", () => {
        createGameBtn.style.background = "#4ade80";
    });
    lobbyPanel.appendChild(createGameBtn);

    // Lobby list container
    const lobbyList = document.createElement("div");
    lobbyList.id = "mainRoomLobbyList";
    lobbyList.style.flex = "1";
    lobbyList.style.overflowY = "auto";
    lobbyList.style.display = "flex";
    lobbyList.style.flexDirection = "column";
    lobbyList.style.gap = "10px";

    // Populate with existing lobbies
    updateLobbyListContent(lobbyList, data.lobbies || []);

    lobbyPanel.appendChild(lobbyList);
    contentArea.appendChild(lobbyPanel);

    container.appendChild(contentArea);
    document.body.appendChild(container);
}

function createChatMessageElement(username, message) {
    const msgDiv = document.createElement("div");
    msgDiv.style.marginBottom = "8px";
    msgDiv.style.wordWrap = "break-word";

    const nameSpan = document.createElement("span");
    nameSpan.innerText = username + ": ";
    nameSpan.style.fontWeight = "bold";
    nameSpan.style.color = getUsernameColor(username);
    msgDiv.appendChild(nameSpan);

    const textSpan = document.createElement("span");
    textSpan.innerText = message;
    textSpan.style.color = "#e5e7eb";
    msgDiv.appendChild(textSpan);

    return msgDiv;
}

function addMainRoomChatMessage(username, message) {
    const chatMessages = document.getElementById("mainRoomChatMessages");
    if (!chatMessages) return;

    // Assign distinct color if new user
    if (!mainRoomUserColors[username]) {
        mainRoomUserColors[username] = generateDistinctColor(username, Object.values(mainRoomUserColors));
    }

    const msgDiv = createChatMessageElement(username, message);
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateLobbyList(lobbies) {
    const lobbyList = document.getElementById("mainRoomLobbyList");
    if (!lobbyList) return;

    updateLobbyListContent(lobbyList, lobbies);
}

function updateLobbyListContent(container, lobbies) {
    container.innerHTML = "";

    if (!lobbies || lobbies.length === 0) {
        const emptyMsg = document.createElement("div");
        emptyMsg.innerText = "No active lobbies. Create one!";
        emptyMsg.style.color = "#9ca3af";
        emptyMsg.style.fontStyle = "italic";
        emptyMsg.style.textAlign = "center";
        emptyMsg.style.padding = "20px";
        container.appendChild(emptyMsg);
        return;
    }

    lobbies.forEach(lobby => {
        const lobbyCard = document.createElement("div");
        lobbyCard.style.background = "rgba(0, 0, 0, 0.4)";
        lobbyCard.style.borderRadius = "6px";
        lobbyCard.style.padding = "12px";
        lobbyCard.style.border = "1px solid #4a5568";

        // Lobby info row
        const infoRow = document.createElement("div");
        infoRow.style.display = "flex";
        infoRow.style.justifyContent = "space-between";
        infoRow.style.alignItems = "center";
        infoRow.style.marginBottom = "8px";

        const lobbyName = document.createElement("span");
        lobbyName.innerText = lobby.name || `Lobby ${lobby.id.slice(0, 6)}`;
        lobbyName.style.fontWeight = "bold";
        lobbyName.style.color = "#fff";
        infoRow.appendChild(lobbyName);

        const playerCount = document.createElement("span");
        playerCount.innerText = `${lobby.playerCount}/4`;
        playerCount.style.color = lobby.playerCount >= 4 ? "#f87171" : "#4ade80";
        playerCount.style.fontSize = "14px";
        infoRow.appendChild(playerCount);

        lobbyCard.appendChild(infoRow);

        // Player names
        const playerNames = document.createElement("div");
        playerNames.style.fontSize = "12px";
        playerNames.style.color = "#9ca3af";
        playerNames.style.marginBottom = "8px";
        playerNames.innerText = lobby.players.map(p => p.username).join(", ");
        lobbyCard.appendChild(playerNames);

        // Join button
        const joinBtn = document.createElement("button");
        if (lobby.playerCount >= 4) {
            joinBtn.innerText = "Full";
            joinBtn.disabled = true;
            joinBtn.style.background = "#6b7280";
            joinBtn.style.cursor = "not-allowed";
        } else {
            joinBtn.innerText = "Join";
            joinBtn.style.background = "#3b82f6";
            joinBtn.style.cursor = "pointer";
            joinBtn.addEventListener("click", () => {
                socket.emit("joinLobby", { lobbyId: lobby.id });
            });
            joinBtn.addEventListener("mouseenter", () => {
                if (!joinBtn.disabled) joinBtn.style.background = "#2563eb";
            });
            joinBtn.addEventListener("mouseleave", () => {
                if (!joinBtn.disabled) joinBtn.style.background = "#3b82f6";
            });
        }
        joinBtn.style.width = "100%";
        joinBtn.style.padding = "8px";
        joinBtn.style.borderRadius = "4px";
        joinBtn.style.border = "none";
        joinBtn.style.color = "#fff";
        joinBtn.style.fontSize = "14px";
        joinBtn.style.fontWeight = "bold";
        lobbyCard.appendChild(joinBtn);

        container.appendChild(lobbyCard);
    });
}

function removeMainRoom() {
    const mainRoom = document.getElementById("mainRoomContainer");
    if (mainRoom) mainRoom.remove();
}

function updateMainRoomOnlineCount(count) {
    const countEl = document.getElementById("mainRoomOnlineCount");
    if (countEl) {
        countEl.innerText = `${count} players online`;
    }
}

// ==================== END MAIN ROOM ====================

// ==================== GAME LOBBY (Pre-game with Ready/Chat) ====================

let currentLobbyId = null;
let isPlayerReady = false;

function showGameLobby(lobbyData) {
    console.log("🎮 Showing game lobby...", lobbyData);
    currentLobbyId = lobbyData.lobbyId;
    isPlayerReady = false;

    // Remove any existing UI
    removeMainRoom();
    removePlayerQueue();
    let oldGameLobby = document.getElementById("gameLobbyContainer");
    if (oldGameLobby) oldGameLobby.remove();

    // Create container
    const container = document.createElement("div");
    container.id = "gameLobbyContainer";
    container.style.position = "fixed";
    container.style.top = "50%";
    container.style.left = "50%";
    container.style.transform = "translate(-50%, -50%)";
    container.style.background = "rgba(26, 26, 46, 0.95)";
    container.style.color = "#fff";
    container.style.padding = "30px";
    container.style.borderRadius = "12px";
    container.style.border = "2px solid #4a5568";
    container.style.fontSize = "16px";
    container.style.width = "400px";
    container.style.maxWidth = "90vw";
    container.style.boxSizing = "border-box";
    container.style.overflow = "hidden";
    container.style.fontFamily = "Arial, sans-serif";
    container.style.textAlign = "center";
    container.style.zIndex = 1000;

    // Header
    const header = document.createElement("div");
    header.innerText = "Game Lobby";
    header.style.fontSize = "28px";
    header.style.fontWeight = "bold";
    header.style.marginBottom = "20px";
    header.style.color = "#4ade80";
    container.appendChild(header);

    // Players list
    const playersDiv = document.createElement("div");
    playersDiv.id = "lobbyPlayersList";
    playersDiv.style.marginBottom = "20px";
    playersDiv.style.textAlign = "left";
    playersDiv.style.padding = "15px";
    playersDiv.style.background = "rgba(0, 0, 0, 0.3)";
    playersDiv.style.borderRadius = "8px";
    updateLobbyPlayersList(playersDiv, lobbyData.players);
    container.appendChild(playersDiv);

    // Chat area
    const chatArea = document.createElement("div");
    chatArea.id = "lobbyChatArea";
    chatArea.style.height = "150px";
    chatArea.style.overflowY = "auto";
    chatArea.style.overflowX = "hidden";
    chatArea.style.background = "rgba(0, 0, 0, 0.4)";
    chatArea.style.borderRadius = "8px";
    chatArea.style.padding = "10px";
    chatArea.style.marginBottom = "15px";
    chatArea.style.textAlign = "left";
    chatArea.style.fontSize = "14px";
    chatArea.style.wordBreak = "break-word";
    chatArea.style.overflowWrap = "break-word";
    // Add any existing messages directly to chatArea element
    if (lobbyData.messages) {
        lobbyData.messages.forEach(msg => {
            const msgDiv = document.createElement("div");
            msgDiv.style.marginBottom = "8px";
            msgDiv.style.wordWrap = "break-word";

            const nameSpan = document.createElement("span");
            nameSpan.innerText = msg.username + ": ";
            nameSpan.style.fontWeight = "bold";
            nameSpan.style.color = "#60a5fa";
            msgDiv.appendChild(nameSpan);

            const textSpan = document.createElement("span");
            textSpan.innerText = msg.message;
            textSpan.style.color = "#e5e7eb";
            msgDiv.appendChild(textSpan);

            chatArea.appendChild(msgDiv);
        });
    }
    container.appendChild(chatArea);

    // Chat input row
    const chatInputRow = document.createElement("div");
    chatInputRow.style.display = "flex";
    chatInputRow.style.gap = "10px";
    chatInputRow.style.marginBottom = "20px";

    const chatInput = document.createElement("input");
    chatInput.id = "lobbyChatInput";
    chatInput.type = "text";
    chatInput.placeholder = "Type a message...";
    chatInput.style.flex = "1";
    chatInput.style.padding = "10px";
    chatInput.style.borderRadius = "6px";
    chatInput.style.border = "1px solid #4a5568";
    chatInput.style.background = "#2d3748";
    chatInput.style.color = "#fff";
    chatInput.style.fontSize = "14px";
    chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && chatInput.value.trim()) {
            socket.emit("lobbyChat", { message: chatInput.value.trim() });
            chatInput.value = "";
        }
    });
    chatInputRow.appendChild(chatInput);

    const sendBtn = document.createElement("button");
    sendBtn.innerText = "Send";
    sendBtn.style.padding = "10px 20px";
    sendBtn.style.borderRadius = "6px";
    sendBtn.style.border = "none";
    sendBtn.style.background = "#3b82f6";
    sendBtn.style.color = "#fff";
    sendBtn.style.cursor = "pointer";
    sendBtn.addEventListener("click", () => {
        if (chatInput.value.trim()) {
            socket.emit("lobbyChat", { message: chatInput.value.trim() });
            chatInput.value = "";
        }
    });
    chatInputRow.appendChild(sendBtn);
    container.appendChild(chatInputRow);

    // Button row
    const buttonRow = document.createElement("div");
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "15px";
    buttonRow.style.justifyContent = "center";

    const readyBtn = document.createElement("button");
    readyBtn.id = "lobbyReadyBtn";
    readyBtn.style.padding = "15px 40px";
    readyBtn.style.fontSize = "18px";
    readyBtn.style.fontWeight = "bold";
    readyBtn.style.borderRadius = "8px";
    readyBtn.style.border = "none";
    readyBtn.style.color = "#000";

    // Set initial state based on player count
    const playerCount = lobbyData.players ? lobbyData.players.length : 0;
    if (playerCount < 4) {
        readyBtn.innerText = `Waiting for ${4 - playerCount} more...`;
        readyBtn.style.background = "#6b7280";
        readyBtn.style.cursor = "not-allowed";
        readyBtn.disabled = true;
    } else {
        readyBtn.innerText = "Ready";
        readyBtn.style.background = "#4ade80";
        readyBtn.style.cursor = "pointer";
        readyBtn.disabled = false;
    }

    readyBtn.addEventListener("click", () => {
        if (readyBtn.disabled) return;

        if (!isPlayerReady) {
            socket.emit("playerReady");
            readyBtn.innerText = "Ready!";
            readyBtn.style.background = "#22c55e";
            readyBtn.style.cursor = "pointer";
            isPlayerReady = true;
        } else {
            socket.emit("playerUnready");
            readyBtn.innerText = "Ready";
            readyBtn.style.background = "#4ade80";
            readyBtn.style.cursor = "pointer";
            isPlayerReady = false;
        }
    });
    buttonRow.appendChild(readyBtn);

    const leaveBtn = document.createElement("button");
    leaveBtn.innerText = "Leave";
    leaveBtn.style.padding = "15px 30px";
    leaveBtn.style.fontSize = "18px";
    leaveBtn.style.borderRadius = "8px";
    leaveBtn.style.border = "none";
    leaveBtn.style.background = "#dc2626";
    leaveBtn.style.color = "#fff";
    leaveBtn.style.cursor = "pointer";
    leaveBtn.addEventListener("click", () => {
        socket.emit("leaveLobby");
    });
    buttonRow.appendChild(leaveBtn);
    container.appendChild(buttonRow);

    document.body.appendChild(container);
}

function updateLobbyPlayersList(container, players) {
    if (!container) {
        container = document.getElementById("lobbyPlayersList");
    }
    if (!container) return;

    container.innerHTML = "";

    // Assign colors to new players - existing players keep their color for the session
    players.forEach((player) => {
        if (!lobbyUserColors[player.username]) {
            lobbyUserColors[player.username] = generateDistinctColor(player.username, Object.values(lobbyUserColors));
        }
    });

    // Header with player count
    const header = document.createElement("div");
    header.innerText = `Players (${players.length}/4):`;
    header.style.fontWeight = "bold";
    header.style.marginBottom = "10px";
    header.style.color = "#9ca3af";
    container.appendChild(header);

    // Show existing players
    players.forEach((player, index) => {
        const playerRow = document.createElement("div");
        playerRow.style.display = "flex";
        playerRow.style.justifyContent = "space-between";
        playerRow.style.alignItems = "center";
        playerRow.style.padding = "8px 0";
        playerRow.style.borderBottom = "1px solid #374151";

        const nameSpan = document.createElement("span");
        nameSpan.innerText = player.username;
        nameSpan.style.fontSize = "16px";
        playerRow.appendChild(nameSpan);

        const statusSpan = document.createElement("span");
        if (player.ready) {
            statusSpan.innerText = "✓ Ready";
            statusSpan.style.color = "#4ade80";
        } else {
            statusSpan.innerText = "Waiting...";
            statusSpan.style.color = "#9ca3af";
        }
        statusSpan.style.fontSize = "14px";
        playerRow.appendChild(statusSpan);

        container.appendChild(playerRow);
    });

    // Show empty slots
    for (let i = players.length; i < 4; i++) {
        const emptyRow = document.createElement("div");
        emptyRow.style.display = "flex";
        emptyRow.style.justifyContent = "space-between";
        emptyRow.style.alignItems = "center";
        emptyRow.style.padding = "8px 0";
        emptyRow.style.borderBottom = i < 3 ? "1px solid #374151" : "none";

        const emptySpan = document.createElement("span");
        emptySpan.innerText = "— Empty Slot —";
        emptySpan.style.fontSize = "16px";
        emptySpan.style.color = "#6b7280";
        emptySpan.style.fontStyle = "italic";
        emptyRow.appendChild(emptySpan);

        container.appendChild(emptyRow);
    }

    // Sync local ready state with server data
    const myPlayer = players.find(p => p.username === username);
    if (myPlayer) {
        isPlayerReady = myPlayer.ready;
    }

    // Update Ready button state
    const readyBtn = document.getElementById("lobbyReadyBtn");
    if (readyBtn) {
        if (players.length < 4) {
            // Not enough players - disable button
            readyBtn.disabled = true;
            readyBtn.style.background = "#6b7280";
            readyBtn.style.cursor = "not-allowed";
            readyBtn.innerText = `Waiting for ${4 - players.length} more...`;
        } else if (isPlayerReady) {
            // Player is ready - show ready state
            readyBtn.disabled = false;
            readyBtn.innerText = "Ready!";
            readyBtn.style.background = "#22c55e";
            readyBtn.style.cursor = "pointer";
        } else {
            // Player is not ready - show ready button
            readyBtn.disabled = false;
            readyBtn.style.background = "#4ade80";
            readyBtn.style.cursor = "pointer";
            readyBtn.innerText = "Ready";
        }
    }
}

// Generate a hash-based hue from username
function hashToHue(username) {
    let hash = 5381;
    for (let i = 0; i < username.length; i++) {
        hash = ((hash << 5) + hash) ^ username.charCodeAt(i);
    }
    return Math.abs(hash) % 360;
}

// Generate a color that's visually distinct from existing colors
function generateDistinctColor(username, existingColors) {
    let hue = hashToHue(username);

    // Extract hues from existing colors
    const existingHues = existingColors
        .map(color => {
            const match = color.match(/hsl\((\d+)/);
            return match ? parseInt(match[1]) : null;
        })
        .filter(h => h !== null);

    // Adjust hue if too close to existing ones (within 50 degrees)
    const minDistance = 50;
    let attempts = 0;
    while (attempts < 360 && existingHues.length > 0) {
        const tooClose = existingHues.some(existingHue => {
            const diff = Math.abs(hue - existingHue);
            return Math.min(diff, 360 - diff) < minDistance;
        });
        if (!tooClose) break;
        hue = (hue + 67) % 360; // Prime number for better distribution
        attempts++;
    }

    return `hsl(${hue}, 70%, 60%)`;
}

// Get color for a username - uses stored color if available
function getUsernameColor(username) {
    if (lobbyUserColors[username]) {
        return lobbyUserColors[username];
    }
    if (mainRoomUserColors[username]) {
        return mainRoomUserColors[username];
    }
    // Fallback for System messages or other contexts
    return `hsl(${hashToHue(username)}, 70%, 60%)`;
}

function addLobbyChatMessage(username, message) {
    const chatArea = document.getElementById("lobbyChatArea");
    if (!chatArea) return;

    const msgDiv = document.createElement("div");
    msgDiv.style.marginBottom = "8px";
    msgDiv.style.wordWrap = "break-word";

    const nameSpan = document.createElement("span");
    nameSpan.innerText = username + ": ";
    nameSpan.style.fontWeight = "bold";
    nameSpan.style.color = getUsernameColor(username);
    msgDiv.appendChild(nameSpan);

    const textSpan = document.createElement("span");
    textSpan.innerText = message;
    textSpan.style.color = "#e5e7eb";
    msgDiv.appendChild(textSpan);

    chatArea.appendChild(msgDiv);
    chatArea.scrollTop = chatArea.scrollHeight;
}

function removeGameLobby() {
    const gameLobby = document.getElementById("gameLobbyContainer");
    if (gameLobby) gameLobby.remove();
    currentLobbyId = null;
    isPlayerReady = false;
    lobbyUserColors = {};
}

// ==================== END GAME LOBBY ====================

function showFinalScore(teamScore, opponentScore) {
    console.log("📢 Adding final score to game log...");

    // Get player names
    let teamName = playerData.username[playerData.position.indexOf(position)].username + "/" + playerData.username[playerData.position.indexOf(team(position))].username;
    let oppName = playerData.username[playerData.position.indexOf(rotate(position))].username + "/" + playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))].username;

    // Determine winner
    let resultMsg = teamScore > opponentScore ? "YOU WIN!" : (teamScore < opponentScore ? "YOU LOSE" : "TIE GAME");

    // Update the score display in the game log header
    updateGameLogScore(teamName, oppName, teamScore, opponentScore);

    // Add to game log
    addToGameFeed("=== GAME OVER ===");
    addToGameFeed(`${teamName}: ${teamScore}`);
    addToGameFeed(`${oppName}: ${opponentScore}`);
    addToGameFeed(resultMsg);

    // Create a simple centered button to return to lobby
    let overlay = document.createElement("div");
    overlay.id = "finalScore";
    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100vw";
    overlay.style.height = "100vh";
    overlay.style.background = "rgba(0, 0, 0, 0.5)";
    overlay.style.display = "flex";
    overlay.style.justifyContent = "center";
    overlay.style.alignItems = "center";
    overlay.style.zIndex = "1000";

    let closeButton = document.createElement("button");
    closeButton.innerText = "Return to Lobby";
    closeButton.style.padding = "16px 32px";
    closeButton.style.fontSize = "18px";
    closeButton.style.background = "#dc2626";
    closeButton.style.color = "#FFF";
    closeButton.style.border = "none";
    closeButton.style.borderRadius = "8px";
    closeButton.style.cursor = "pointer";
    closeButton.onclick = hideFinal;

    overlay.appendChild(closeButton);
    document.body.appendChild(overlay);
}
function hideFinal() {
    let overlay = document.getElementById("finalScore");
    if (overlay) {
        overlay.remove();
        console.log(" Final score popup closed.");

        // Remove game feed/log
        let gameFeed = document.getElementById("gameFeed");
        if (gameFeed) {
            gameFeed.remove();
        }

        // Remove width restriction from game container
        document.getElementById('game-container').classList.remove('in-game');

        gameScene.scene.restart();
        socket.off("gameStart");
        playZone = null;
        handBackground = null;
        // Return to main room
        socket.emit("joinMainRoom");
    }
}
function initGameChat(){
    let chatCheck = document.getElementById("gameChatContainer");
    if (chatCheck){
        return;
    }

    // Create main chat container using CSS class
    let container = document.createElement("div");
    container.id = "gameChatContainer";
    container.classList.add("chat-container", "ui-element");

    // Header
    let header = document.createElement("div");
    header.classList.add("chat-header");
    header.innerText = "Game Log";
    container.appendChild(header);

    // Messages area
    let messages = document.createElement("div");
    messages.id = "gameChatMessages";
    messages.classList.add("chat-messages");
    container.appendChild(messages);

    // Input container
    let inputContainer = document.createElement("div");
    inputContainer.classList.add("chat-input-container");

    let chatInput = document.createElement("input");
    chatInput.type = "text";
    chatInput.id = "chatInput";
    chatInput.classList.add("chat-input");
    chatInput.placeholder = "Type a message...";

    let sendBtn = document.createElement("button");
    sendBtn.classList.add("chat-send");
    sendBtn.innerText = "Send";

    inputContainer.appendChild(chatInput);
    inputContainer.appendChild(sendBtn);
    container.appendChild(inputContainer);

    document.body.appendChild(container);

    // Handle sending messages
    function sendMessage() {
        let message = chatInput.value.trim();
        if (message !== "") {
            console.log("Sending message:", message);
            socket.emit("chatMessage", { message });
            chatInput.value = "";
        }
    }

    sendBtn.addEventListener("click", sendMessage);
    chatInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            sendMessage();
        }
    });
}

// Add message to game chat log
function addGameChatMessage(sender, message, isSystem = false) {
    let messages = document.getElementById("gameChatMessages");
    if (!messages) return;

    let msgDiv = document.createElement("div");
    msgDiv.classList.add("chat-message");
    if (isSystem) {
        msgDiv.classList.add("system");
    }

    let senderSpan = document.createElement("span");
    senderSpan.classList.add("sender");
    senderSpan.innerText = sender + ":";

    let textSpan = document.createElement("span");
    textSpan.classList.add("text");
    textSpan.innerText = message;

    msgDiv.appendChild(senderSpan);
    msgDiv.appendChild(textSpan);
    messages.appendChild(msgDiv);

    // Auto-scroll to bottom
    messages.scrollTop = messages.scrollHeight;
}
function clearScreen() {
    console.log("🔥 Clearing all elements from the screen...");

    // ✅ Loop through all scene children and destroy them
    this.children.list.forEach(child => {
        if (child && child.destroy) {
            child.destroy();
        }
    });
    if (this.playZone) {
        this.playZone.destroy();
        this.playZone = null;
        console.log("🛑 Play zone removed.");
    }

    if (this.border) {
        this.border.destroy();
        this.border = null;
        console.log("🛑 Hand area background removed.");
    }

    if (this.tableCardLabel) {
        this.tableCardLabel.destroy();
        this.tableCardLabel = null;
        console.log("🛑 Table card label removed.");
    }
    // ✅ Remove all interactive events to prevent conflicts
    this.input.removeAllListeners();

    console.log("✅ All elements removed from the screen.");
}
function createSpeechBubble(scene, x, bottomY, width, height, text, color) {
    let scaleFactorX = scene.scale.width / 1920; // Adjust based on your design resolution
    let scaleFactorY = scene.scale.height / 953; // Adjust based on your design resolution
    const PADDING   = 10;
    const TAIL_SIZE = 20*scaleFactorX;
    const MAX_W     = 350*scaleFactorX;  // Increased for longer messages
    const MAX_H     = 200*scaleFactorY;  // Increased for longer messages
  
    // 1) style & measure the text off-screen
    const style = {
      fontSize:  "16px",
      fontFamily:"Arial",
      color:     (color === "#FF0000" ? "#FF0000" : "#000000"),
      wordWrap:  { width: MAX_W - 2*PADDING }
    };
    const textObj = scene.add.text(0, 0, text, style);
  
    // 2) clamp its measured size
    const txtW = Math.min(textObj.width,  MAX_W - 2*PADDING);
    const txtH = Math.min(textObj.height, MAX_H - 2*PADDING);
  
    // final bubble dims
    const bW = txtW + 2*PADDING;
    const bH = txtH + 2*PADDING;
  
    // 3) compute the top‐left Y so the bottom edge sits at bottomY
    const topY = bottomY - bH;
  
    // 4) position the text inside the bubble
    textObj.setPosition(x + PADDING, topY + PADDING);
  
    // 5) draw the bubble background at (x, topY)
    const bubble = scene.add.graphics();
    bubble.fillStyle(0xffffff, 1);
    bubble.fillRoundedRect(x, topY, bW, bH, 16);
  
    // 6) draw the tail so it “points” down at bottomY
    //    (adjust its triangle coords accordingly)
    bubble.fillTriangle(
      x + 20,      topY + bH,       // left corner of bottom edge
      x - TAIL_SIZE, topY + bH,     // tail tip farther left
      x + 10,      topY + bH - TAIL_SIZE
    );
  
    // 7) mask off any overflow below the rect
    const maskShape = scene.make.graphics();
    maskShape.fillStyle(0xffffff);
    maskShape.fillRect(x, topY, bW, bH);
    const mask = maskShape.createGeometryMask();
  
    // 8) group & apply mask
    const container = scene.add.container(0, 0, [bubble, textObj]);
    container.setMask(mask);
    container.setDepth(500);
    container.setAlpha(1);
  
    return container;
  }
function createPlayerInfoBox() {
    // Safety check: ensure playerData is fully populated
    if (!playerData || !playerData.username || !playerData.position || !playerData.pics) {
        console.warn("⚠️ createPlayerInfoBox called before playerData is ready, deferring...");
        return null;
    }

    let positionIndex = playerData.position.indexOf(position);
    if (positionIndex === -1 || !playerData.username[positionIndex]) {
        console.warn("⚠️ createPlayerInfoBox: position not found in playerData, deferring...");
        return null;
    }

    let screenWidth = gameScene.scale.width;
    let screenHeight = gameScene.scale.height;
    let scaleFactorX = screenWidth / 1920; // Adjust based on your design resolution
    let scaleFactorY = screenHeight / 953; // Adjust based on your design resolution

    let boxWidth = 180*scaleFactorX;;
    let boxHeight = 200*scaleFactorY;
    let boxX = screenWidth - 380*scaleFactorX; // Position it where the bid UI used to be
    let boxY = screenHeight - 150*scaleFactorY; // Near the hand area

    // ✅ Create the dark background for player info
    let playerBox = gameScene.add.rectangle(boxX, boxY, boxWidth, boxHeight, 0x222222)
        .setOrigin(0.5)
        .setAlpha(0.8) // Semi-transparent
        .setStrokeStyle(3, 0xffffff); // White border

    // ✅ Player Name Text
    let playerAvatar = gameScene.add.image(boxX, boxY - 110*scaleFactorY, "profile" + playerData.pics[positionIndex]) // Load texture from assets
        .setScale(0.2) // Adjust size
        .setOrigin(0.5)
    let playerNameText = gameScene.add.text(boxX, boxY - 40*scaleFactorY, playerData.username[positionIndex].username, {
        fontSize: "18px",
        fontFamily: "Arial",
        color: "#ffffff"
    }).setOrigin(0.5);

    // ✅ Score Text
    let playerPositionText = gameScene.add.text(boxX, boxY, "POSITION: " + position, {
        fontSize: "16px",
        fontFamily: "Arial",
        color: "#ffffff"
    }).setOrigin(0.5);

    // ✅ Group all elements into a container
    let playerInfoContainer = gameScene.add.container(0, 0, [playerBox, playerAvatar, playerNameText, playerPositionText]);

    return {playerBox, playerAvatar, playerNameText, playerPositionText, playerInfoContainer};
}
function createScorebug(){
    const screenWidth = gameScene.scale.width;
    const screenHeight = gameScene.scale.height;
    let scaleFactorX = screenWidth / 1920; // Adjust based on your design resolution
    let scaleFactorY = screenHeight / 953; // Adjust based on your design resolution
    const padding = 20;
    const boxWidth = 300*scaleFactorX;
    const boxHeight = 60*scaleFactorY;

    const scorebugX = screenWidth - boxWidth - padding;
    const scorebugY = padding;

    // ✅ Background box
    const background = gameScene.add.rectangle(scorebugX, scorebugY, boxWidth, boxHeight, 0x222222)
        .setOrigin(0, 0)
        .setAlpha(0.85)
        .setStrokeStyle(2, 0xffffff)
        .setDepth(300);

    // ✅ Team Score Labels
    const teamScoreLabel = gameScene.add.text(scorebugX + 10*scaleFactorX, scorebugY + 8*scaleFactorY, "Team: 0", {
        fontSize: "16px",
        fontFamily: "Arial",
        fontStyle: "bold",
        color: "#00ff00"
    }).setDepth(301);

    const oppScoreLabel = gameScene.add.text(scorebugX + 10*scaleFactorX, scorebugY + 32*scaleFactorY, "Opp: 0", {
        fontSize: "16px",
        fontFamily: "Arial",
        fontStyle: "bold",
        color: "#ff3333"
    }).setDepth(301);

    // ✅ Function to update scorebug position and size on resize
    function updateScorebugLayout() {
        const newScreenWidth = gameScene.scale.width;
        const newScreenHeight = gameScene.scale.height;
        const newScaleFactorX = newScreenWidth / 1920;
        const newScaleFactorY = newScreenHeight / 953;
        const newBoxWidth = 300 * newScaleFactorX;
        const newBoxHeight = 60 * newScaleFactorY;
        const newScorebugX = newScreenWidth - newBoxWidth - padding;

        background.setPosition(newScorebugX, padding);
        background.setSize(newBoxWidth, newBoxHeight);
        teamScoreLabel.setPosition(newScorebugX + 10 * newScaleFactorX, padding + 8 * newScaleFactorY);
        oppScoreLabel.setPosition(newScorebugX + 10 * newScaleFactorX, padding + 32 * newScaleFactorY);
    }

    // Listen for resize events
    gameScene.scale.on('resize', updateScorebugLayout);

    // ✅ Return references to update later
    return { background, teamScoreLabel, oppScoreLabel, updateLayout: updateScorebugLayout };
}
function showImpactEvent(event){
    let scene = game.scene.scenes[0];
    const screenWidth = scene.scale.width;
    const screenHeight = scene.scale.height;
    const impactImage = scene.add.image(screenWidth / 2, screenHeight / 2, event)
        .setScale(0)      // Start small for impact effect
        .setAlpha(1)      // Fully visible
        .setDepth(999);   // Make sure it's on top

    // 2. Tween for impact effect (scale up + bounce)
    scene.tweens.add({
        targets: impactImage,
        scale: { from: 0, to: 1.2 },
        ease: 'Back.Out',
        duration: 500
    });

    // 3. Remove the image after 3 seconds
    scene.time.delayedCall(1500, () => {
        scene.tweens.add({
            targets: impactImage,
            alpha: { from: 1, to: 0 },
            duration: 1000, // 1 second fade
            ease: 'Power1',
            onComplete: () => {
                impactImage.destroy(); // Clean up
            }
        });
    });
}
window.onload = () => {
    // Check if user is logged in and was in a game
    const username = sessionStorage.getItem('username');
    const gameId = sessionStorage.getItem('gameId');

    if (!username) {
        showSignInScreen();
    } else if (gameId) {
        // Was in a game - socketManager will attempt rejoin
        // The rejoinSuccess/rejoinFailed handlers in game.js will handle the UI
    } else {
        // Go to main room
        socket.emit("joinMainRoom");
    }
};