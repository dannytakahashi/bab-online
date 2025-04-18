
let bidValue = "'";
if ((bidValue < 0 || bidValue > 4)){
    console.log("invalid out of range");
}
else if((isNaN(Number(bidValue))) && (bidValue.toUpperCase() !== "B" && bidValue.toUpperCase() !== "2B" && bidValue.toUpperCase() !== "3B" && bidValue.toUpperCase() !== "4B")){
    console.log(bidValue.toUpperCase());
    console.log("⚠️ Invalid bid entered.");
    return false;;
}
else{
    console.log("✅ Valid bid entered.");
    return true;
}