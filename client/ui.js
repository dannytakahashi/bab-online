
let username = ""; // ✅ Stores the player's username
let password = ""; // ✅ Stores the player's password

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
    signInVignette.classList.add("vignette"); // ✅ Add a class for easy removal
    signInVignette.style.position = "fixed";
    signInVignette.style.top = "0";
    signInVignette.style.left = "0";
    signInVignette.style.width = "100vw";
    signInVignette.style.height = "100vh";
    signInVignette.style.pointerEvents = "none"; // ✅ Allows interaction with UI elements underneath
    signInVignette.style.background = "radial-gradient(circle, rgba(34, 139, 34, 1) 30%, rgba(0, 0, 0, 1) 100%)";
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
    let logo = document.createElement("img");
    logo.src = "assets/logo.png"; // ✅ Path to your logo image
    logo.alt = "Game Logo";
    logo.style.width = "500px"; // ✅ Adjust size as needed
    logo.style.marginBottom = "20px";
    logo.style.position = "relative";
    logo.style.left = "30px"
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
    let signUpButton = document.createElement("button");
    signUpButton.innerText = "Register";
    signUpButton.style.fontSize = "14px";
    signUpButton.style.padding = "10px 20px";
    signUpButton.style.borderRadius = "5px";
    signUpButton.style.border = "none";
    signUpButton.style.background = "#007bff";
    signUpButton.style.color = "#fff";
    signUpButton.style.cursor = "pointer";
    signUpButton.style.marginTop = "10px";

    signUpButton.onclick = showRegisterScreen;
    signInContainer.appendChild(signUpButton);
    document.body.appendChild(signInContainer);
}
function showRegisterScreen(){
    let registerVignette = document.createElement("div");
    registerVignette.classList.add("vignette"); // ✅ Add a class for easy removal
    registerVignette.style.position = "fixed";
    registerVignette.style.top = "0";
    registerVignette.style.left = "0";
    registerVignette.style.width = "100vw";
    registerVignette.style.height = "100vh";
    registerVignette.style.pointerEvents = "none"; // ✅ Allows interaction with UI elements underneath
    registerVignette.style.background = "radial-gradient(circle, rgba(34, 139, 34, 1) 30%, rgba(0, 0, 0, 1) 100%)";
    document.body.appendChild(registerVignette); 

    let registerContainer = document.createElement("div");
    registerContainer.id = "signInContainer";
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
    let logo = document.createElement("img");
    logo.src = "assets/logo.png"; // ✅ Path to your logo image
    logo.alt = "Game Logo";
    logo.style.width = "500px"; // ✅ Adjust size as needed
    logo.style.marginBottom = "20px";
    logo.style.position = "relative";
    logo.style.left = "30px"
    registerContainer.appendChild(logo); 
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
    registerContainer.appendChild(usernameInput);

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
    document.body.appendChild(registerContainer);
}
socket.on("signInResponse", (data) => {
    if (data.success) {
        console.log(`✅ Sign-in successful: ${username}`);
        sessionStorage.setItem("username", username);
        showLobbyScreen(); // ✅ Move to lobby if sign-in is successful
    } else {
        alert("❌ Sign-in failed! Incorrect username or password.");
    }
});
// ✅ Listen for Sign-Up Response
socket.on("signUpResponse", (data) => {
    if (data.success) {
        alert("✅ Registration successful! Please sign in.");
    } else {
        alert(`❌ Registration failed: ${data.message}`);
    }
});
// ✅ Function to Handle Sign-In Response

function showScore(teamScore, opponentScore, bidArray, team1Tricks, team2Tricks, team1OldScore, team2OldScore) {
    console.log("📢 Displaying score popup...");

    // ✅ Create the dimmed background
    let overlay = document.createElement("div");
    overlay.id = "popupOverlay";
    overlay.style.position = "absolute";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100vw";
    overlay.style.height = "100vh";
    overlay.style.background = "rgba(0, 0, 0, 0.7)";
    overlay.style.display = "flex";
    overlay.style.justifyContent = "center";
    overlay.style.alignItems = "center";
    overlay.style.zIndex = "1000";

    // ✅ Create the popup box
    let popup = document.createElement("div");
    popup.id = "popupBox";
    popup.style.width = "650px"; // ✅ Increased width for 3 sections
    popup.style.padding = "20px";
    popup.style.background = "#FFF";
    popup.style.color = "#000";
    popup.style.borderRadius = "10px";
    popup.style.textAlign = "center";
    popup.style.boxShadow = "0px 0px 15px rgba(255, 255, 255, 0.5)";
    popup.style.fontSize = "18px";

    // ✅ Title text (Italicized)
    let title = document.createElement("p");
    title.innerText = "SCORE UPDATE";
    title.style.fontWeight = "bold";
    title.style.fontStyle = "italic";
    popup.appendChild(title);

    // ✅ Create a container for the 3 text sections
    let scoreContainer = document.createElement("div");
    scoreContainer.style.display = "flex";
    scoreContainer.style.justifyContent = "space-between";
    scoreContainer.style.marginBottom = "10px";
    scoreContainer.style.width = "100%";

    // ✅ Third Text Field (Left Side, No Background)
    let testTextSection = document.createElement("div");
    testTextSection.style.display = "flex";
    testTextSection.style.flexDirection = "column"; 
    testTextSection.style.alignItems = "center";
    testTextSection.style.width = "30%";

    let testTitle = document.createElement("p");
    testTitle.innerText = "";
    testTitle.style.fontWeight = "bold";
    testTitle.style.marginBottom = "5px";

    let testTextBox = document.createElement("div");
    testTextBox.innerText = "\n\nCONTRACT\nACTUAL\nOLD SCORE\nTHIS ROUND\nSCORE";
    testTextBox.style.fontSize = "16px";
    testTextBox.style.textAlign = "right";
    testTextBox.style.alignItems = "center";
    testTextBox.style.fontWeight = "bold";

    testTextSection.appendChild(testTitle);
    testTextSection.appendChild(testTextBox);

    // ✅ Team Score Section (Middle)
    let teamScoreSection = document.createElement("div");
    teamScoreSection.style.display = "flex";
    teamScoreSection.style.flexDirection = "column";
    teamScoreSection.style.alignItems = "center";
    teamScoreSection.style.width = "30%";

    let teamTitle = document.createElement("p");
    teamTitle.innerText = playerData.username[playerData.position.indexOf(1)].username + "/" + playerData.username[playerData.position.indexOf(team(1))].username;
    teamTitle.style.fontWeight = "bold";
    teamTitle.style.marginBottom = "5px";

    let teamScoreBox = document.createElement("div");
    if(teamScore > team1OldScore){
        teamScoreBox.innerText = bidArray[0] + "/" + bidArray [2] + "\n" + team1Tricks + "\n" + team1OldScore + "\n" + "+" + (teamScore - team1OldScore) + "\n" + teamScore;
    }else{
        teamScoreBox.innerText = bidArray[0] + "/" + bidArray [2] + "\n" + team1Tricks + "\n" + team1OldScore + "\n" + (teamScore - team1OldScore) + "\n" + teamScore;
    }
    teamScoreBox.style.width = "100%";
    teamScoreBox.style.minHeight = "60px";
    teamScoreBox.style.padding = "10px";
    teamScoreBox.style.fontSize = "16px";
    teamScoreBox.style.textAlign = "center";
    teamScoreBox.style.border = "2px solid #8B4513";
    teamScoreBox.style.background = "#FFF8DC";
    teamScoreBox.style.borderRadius = "8px";
    teamScoreBox.style.fontWeight = "bold";
    teamScoreBox.style.whiteSpace = "pre-line";

    teamScoreSection.appendChild(teamTitle);
    teamScoreSection.appendChild(teamScoreBox);

    // ✅ Opponent Score Section (Right)
    let opponentScoreSection = document.createElement("div");
    opponentScoreSection.style.display = "flex";
    opponentScoreSection.style.flexDirection = "column";
    opponentScoreSection.style.alignItems = "center";
    opponentScoreSection.style.width = "30%";

    let opponentTitle = document.createElement("p");
    opponentTitle.innerText = playerData.username[playerData.position.indexOf(rotate(1))].username + "/" + playerData.username[playerData.position.indexOf(rotate(rotate(rotate(1))))].username;
    opponentTitle.style.fontWeight = "bold";
    opponentTitle.style.marginBottom = "5px";

    let opponentScoreBox = document.createElement("div");
    if(opponentScore > team2OldScore){
        opponentScoreBox.innerText = bidArray[1] + "/" + bidArray [3] + "\n" + team2Tricks + "\n" + team2OldScore + "\n" + "+" + (opponentScore - team2OldScore) + "\n" + opponentScore;
    }else{
        opponentScoreBox.innerText = bidArray[1] + "/" + bidArray [3] + "\n" + team2Tricks + "\n" + team2OldScore + "\n" + (opponentScore - team2OldScore) + "\n" + opponentScore;
    }
    opponentScoreBox.style.width = "100%";
    opponentScoreBox.style.minHeight = "60px";
    opponentScoreBox.style.padding = "10px";
    opponentScoreBox.style.fontSize = "16px";
    opponentScoreBox.style.textAlign = "center";
    opponentScoreBox.style.border = "2px solid #8B4513";
    opponentScoreBox.style.background = "#FFF8DC";
    opponentScoreBox.style.borderRadius = "8px";
    opponentScoreBox.style.fontWeight = "bold";
    opponentScoreBox.style.whiteSpace = "pre-line";

    opponentScoreSection.appendChild(opponentTitle);
    opponentScoreSection.appendChild(opponentScoreBox);

    // ✅ Append all sections to the container
    scoreContainer.appendChild(testTextSection);
    scoreContainer.appendChild(teamScoreSection);
    scoreContainer.appendChild(opponentScoreSection);
    popup.appendChild(scoreContainer);

    // ✅ Submit button
    let closeButton = document.createElement("button");
    closeButton.innerText = "OK";
    closeButton.style.marginTop = "10px";
    closeButton.style.padding = "8px 16px";
    closeButton.style.background = "#D50505";
    closeButton.style.color = "#FFF";
    closeButton.style.border = "none";
    closeButton.style.borderRadius = "5px";
    closeButton.style.cursor = "pointer";

    // ✅ Close popup when clicking "OK"
    closeButton.onclick = hidePopup;

    popup.appendChild(closeButton);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
}

// ✅ Function to Hide the Popup
function hidePopup() {
    let overlay = document.getElementById("popupOverlay");
    if (overlay) {
        overlay.remove();
        console.log("❌ Score popup closed.");
    }
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


    // ✅ Join Queue Button
    let joinButton = document.createElement("button");
    joinButton.innerText = "Join Queue";
    joinButton.style.fontSize = "20px";
    joinButton.style.padding = "10px 20px";
    joinButton.style.borderRadius = "5px";
    joinButton.style.border = "none";
    joinButton.style.background = "#28a745";
    joinButton.style.color = "#fff";
    joinButton.style.cursor = "pointer";

    joinButton.onclick = () => {
        console.log("📡 Joining queue...");
        socket.emit("joinQueue"); // ✅ Notify server
        showWaitingScreen(); // ✅ Show waiting screen
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
    logo.style.width = "200px"; // ✅ Adjust size as needed
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
    container.style.minWidth = "300px";
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

    // ✅ Create waiting container
    /*waitingVignette = document.createElement("div");
    waitingVignette.classList.add("vignette"); // ✅ Add a class for easy removal
    waitingVignette.style.position = "fixed";
    waitingVignette.style.top = "0";
    waitingVignette.style.left = "0";
    waitingVignette.style.width = "100vw";
    waitingVignette.style.height = "100vh";
    waitingVignette.style.pointerEvents = "none"; // ✅ Allows interaction with UI elements underneath
    waitingVignette.style.background = "radial-gradient(circle, rgba(34, 139, 34, 1) 30%, rgba(0, 0, 0, 1) 100%)";
    document.body.appendChild(waitingVignette); 

    let waitingContainer = document.createElement("div");
    waitingContainer.id = "waitingContainer";
    waitingContainer.style.position = "absolute";
    waitingContainer.style.top = "0";
    waitingContainer.style.left = "0";
    waitingContainer.style.width = "100vw";
    waitingContainer.style.height = "100vh";
    waitingContainer.style.background = "none"; // Darker background
    waitingContainer.style.display = "flex";
    waitingContainer.style.flexDirection = "column";
    waitingContainer.style.justifyContent = "center";
    waitingContainer.style.alignItems = "center";
    waitingContainer.style.color = "white";
    waitingContainer.style.fontSize = "24px";

    // ✅ Waiting message
    let waitingText = document.createElement("p");
    waitingText.innerText = "Waiting for players...";
    waitingContainer.appendChild(waitingText);*/

    //document.body.appendChild(waitingContainer);
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
    removeAllVignettes();
    clearUI();
    removePlayerQueue();
    waitBool = false;
    console.log("🚀 Game starting...");
}
function showFinalScore(teamScore, opponentScore) {
    console.log("📢 Displaying score popup...");

    // ✅ Create the dimmed background
    let overlay = document.createElement("div");
    overlay.id = "finalScore";
    overlay.style.position = "absolute";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100vw";
    overlay.style.height = "100vh";
    overlay.style.background = "rgba(0, 0, 0, 0.7)";
    overlay.style.display = "flex";
    overlay.style.justifyContent = "center";
    overlay.style.alignItems = "center";
    overlay.style.zIndex = "1000";

    // ✅ Create the popup box
    let popup = document.createElement("div");
    popup.id = "finalPopupBox";
    popup.style.width = "600px"; // ✅ Increased width for 3 sections
    popup.style.padding = "20px";
    popup.style.background = "#FFF";
    popup.style.color = "#000";
    popup.style.borderRadius = "10px";
    popup.style.textAlign = "center";
    popup.style.boxShadow = "0px 0px 15px rgba(255, 255, 255, 0.5)";
    popup.style.fontSize = "18px";

    // ✅ Title text (Italicized)
    let title = document.createElement("p");
    title.innerText = "FINAL SCORE";
    title.style.fontWeight = "bold";
    title.style.fontStyle = "italic";
    popup.appendChild(title);

    // ✅ Create a container for the 3 text sections
    let scoreContainer = document.createElement("div");
    scoreContainer.style.display = "flex";
    scoreContainer.style.justifyContent = "space-between";
    scoreContainer.style.marginBottom = "10px";
    scoreContainer.style.width = "100%";

    // ✅ Team Score Section (Middle)
    let teamScoreSection = document.createElement("div");
    teamScoreSection.style.display = "flex";
    teamScoreSection.style.flexDirection = "column";
    teamScoreSection.style.alignItems = "center";
    teamScoreSection.style.width = "35%";

    let teamTitle = document.createElement("p");
    teamTitle.innerText = playerData.username[playerData.position.indexOf(position)].username + "/" + playerData.username[playerData.position.indexOf(team(position))].username;;
    teamTitle.style.fontWeight = "bold";
    teamTitle.style.marginBottom = "5px";

    let teamScoreBox = document.createElement("div");
    teamScoreBox.innerText = teamScore;
    teamScoreBox.style.width = "100%";
    teamScoreBox.style.minHeight = "60px";
    teamScoreBox.style.padding = "10px";
    teamScoreBox.style.fontSize = "16px";
    teamScoreBox.style.textAlign = "center";
    teamScoreBox.style.border = "2px solid #8B4513";
    teamScoreBox.style.background = "#FFF8DC";
    teamScoreBox.style.borderRadius = "8px";
    teamScoreBox.style.fontWeight = "bold";
    teamScoreBox.style.whiteSpace = "pre-line";

    teamScoreSection.appendChild(teamTitle);
    teamScoreSection.appendChild(teamScoreBox);

    // ✅ Opponent Score Section (Right)
    let opponentScoreSection = document.createElement("div");
    opponentScoreSection.style.display = "flex";
    opponentScoreSection.style.flexDirection = "column";
    opponentScoreSection.style.alignItems = "center";
    opponentScoreSection.style.width = "35%";

    let opponentTitle = document.createElement("p");
    opponentTitle.innerText = playerData.username[playerData.position.indexOf(rotate(position))].username + "/" + playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))].username;
    opponentTitle.style.fontWeight = "bold";
    opponentTitle.style.marginBottom = "5px";

    let opponentScoreBox = document.createElement("div");
    opponentScoreBox.innerText = opponentScore;
    opponentScoreBox.style.width = "100%";
    opponentScoreBox.style.minHeight = "60px";
    opponentScoreBox.style.padding = "10px";
    opponentScoreBox.style.fontSize = "16px";
    opponentScoreBox.style.textAlign = "center";
    opponentScoreBox.style.border = "2px solid #8B4513";
    opponentScoreBox.style.background = "#FFF8DC";
    opponentScoreBox.style.borderRadius = "8px";
    opponentScoreBox.style.fontWeight = "bold";
    opponentScoreBox.style.whiteSpace = "pre-line";

    opponentScoreSection.appendChild(opponentTitle);
    opponentScoreSection.appendChild(opponentScoreBox);

    // ✅ Append all sections to the container
    scoreContainer.appendChild(teamScoreSection);
    scoreContainer.appendChild(opponentScoreSection);
    popup.appendChild(scoreContainer);

    // ✅ Submit button
    let closeButton = document.createElement("button");
    closeButton.innerText = "Return to Lobby";
    closeButton.style.marginTop = "10px";
    closeButton.style.padding = "8px 16px";
    closeButton.style.background = "#D50505";
    closeButton.style.color = "#FFF";
    closeButton.style.border = "none";
    closeButton.style.borderRadius = "5px";
    closeButton.style.cursor = "pointer";

    // ✅ Close popup when clicking "OK"
    closeButton.onclick = hideFinal;

    popup.appendChild(closeButton);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
}
function hideFinal() {
    let overlay = document.getElementById("finalScore");
    if (overlay) {
        overlay.remove();
        console.log(" Final score popup closed.");
        gameScene.scene.restart();
        socket.off("gameStart");
        playZone = null;
        handBackground = null;
        showLobbyScreen();
    }
}
function initGameChat(){
    let chatCheck = document.getElementById("chatInput");
    if (chatCheck){
        return;
    }
    let chatInput = document.createElement("input");
    chatInput.type = "text";
    chatInput.classList.add("ui-element");
    chatInput.placeholder = "Type a message...";
    chatInput.style.position = "absolute";
    chatInput.style.bottom = "10px";  // Adjust position
    chatInput.style.left = "50%";
    chatInput.style.transform = "translateX(-50%)";
    chatInput.style.fontSize = "18px";
    chatInput.style.padding = "8px";
    chatInput.style.width = "300px";
    chatInput.style.border = "2px solid #8B4513";
    chatInput.style.background = "#FFF8DC"; // Light beige color
    chatInput.style.color = "#000";
    chatInput.style.borderRadius = "8px";
    chatInput.style.textAlign = "center";
    chatInput.style.display = "none"; // ✅ Keep hidden initially
    chatInput.id = "chatInput";
    document.body.appendChild(chatInput);

    // ✅ Listen for "Enter" key to show input field
    document.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && chatInput.style.display === "none") {
            chatInput.style.display = "block";
            chatInput.focus(); // Auto-focus when opened
        } else if (event.key === "Escape") {
            chatInput.style.display = "none"; // Hide on Escape
            chatInput.value = ""; // Clear input
        }
    });

    // ✅ Handle submission when pressing "Enter" inside the input box
    chatInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            let message = chatInput.value.trim();
            if (message !== "") {
                console.log("📡 Sending message:", message);
                socket.emit("chatMessage", { message });
            }
            chatInput.value = ""; // Clear input
            chatInput.style.display = "none"; // Hide after sending
        }
    });     
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
    const PADDING   = 10;
    const TAIL_SIZE = 20;
    const MAX_W     = 250;
    const MAX_H     = 120;
  
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
    let screenWidth = gameScene.scale.width;
    let screenHeight = gameScene.scale.height;

    let boxWidth = 180;
    let boxHeight = 200;
    let boxX = screenWidth - 380; // Position it where the bid UI used to be
    let boxY = screenHeight - 150; // Near the hand area

    // ✅ Create the dark background for player info
    let playerBox = gameScene.add.rectangle(boxX, boxY, boxWidth, boxHeight, 0x222222)
        .setOrigin(0.5)
        .setAlpha(0.8) // Semi-transparent
        .setStrokeStyle(3, 0xffffff); // White border

    // ✅ Player Name Text
    let playerAvatar = gameScene.add.image(boxX, boxY - 110, "profile" + playerData.pics[playerData.position.indexOf(position)]) // Load texture from assets
        .setScale(0.2) // Adjust size
        .setOrigin(0.5)
    let playerNameText = gameScene.add.text(boxX, boxY - 40, playerData.username[playerData.position.indexOf(position)].username, {
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
    const padding = 20;
    const boxWidth = 300;
    const boxHeight = 60;

    const scorebugX = screenWidth - boxWidth - padding;
    const scorebugY = padding;

    // ✅ Background box
    const background = gameScene.add.rectangle(scorebugX, scorebugY, boxWidth, boxHeight, 0x222222)
        .setOrigin(0, 0)
        .setAlpha(0.85)
        .setStrokeStyle(2, 0xffffff)
        .setDepth(300);

    // ✅ Team Score Labels
    const teamScoreLabel = gameScene.add.text(scorebugX + 10, scorebugY + 8, "Team: 0", {
        fontSize: "16px",
        fontFamily: "Arial",
        fontStyle: "bold",
        color: "#00ff00"
    }).setDepth(301);

    const oppScoreLabel = gameScene.add.text(scorebugX + 10, scorebugY + 32, "Opp: 0", {
        fontSize: "16px",
        fontFamily: "Arial",
        fontStyle: "bold",
        color: "#ff3333"
    }).setDepth(301);

    // ✅ Return references to update later
    return { background, teamScoreLabel, oppScoreLabel };
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
        showSignInScreen(); // ✅ Show sign-in if no user is saved
};