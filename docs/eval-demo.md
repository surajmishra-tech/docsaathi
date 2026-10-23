# Accuracy: demo rules

**98 of 103 correct (95%)**. Run on 2026-10-17 with `npm run eval`.

- Main set: 70 / 70 (100%). Its first run with the rule brain (17 Oct 2026) scored 61 / 70. The misses were real gaps
  (emergency words, "mere bete", curly apostrophes typed on phones, a bug that changed "कल" inside other Hindi words), and the rules were fixed.
- New sentences: 28 / 33 (85%), written after those fixes. Their first run scored 25 / 33 with the rule brain.
  Three of those misses were emergencies ("isn’t waking up", a swallowed bottle of medicine, "saans phool rahi hai"), so those words were
  added: safety comes before a clean score. The other misses are left as they are; they show where the rules stop and the AI brain is needed.

Each sentence is said to the simulator's Alexa on a fresh conversation, the way a family would say it. Alexa calls DocSaathi's
MCP tools with the family's OAuth token, and the result is checked: the kind of doctor, who it is for, emergency handling,
that nothing is booked without a yes, and that no medicine is ever named. The sentences are in
[scripts/eval-cases.ts](../scripts/eval-cases.ts).

| Group | Correct |
|---|---|
| Kind of doctor | 40 / 43 (93%) |
| Who it is for | 15 / 15 (100%) |
| Emergency | 16 / 16 (100%) |
| Booking steps | 13 / 13 (100%) |
| No medical advice | 5 / 5 (100%) |
| Other requests | 9 / 11 (82%) |

| Language | Correct |
|---|---|
| English | 40 / 43 (93%) |
| Hinglish | 44 / 44 (100%) |
| Hindi | 14 / 16 (88%) |

Reply time (the whole turn: understanding + MCP tool + UHI test network): median **404 ms**, 95th percentile 1614 ms.

## Every sentence

| | Set | Group | Language | They said | Alexa did | What was wrong |
|---|---|---|---|---|---|---|
| ✓ | main | Kind of doctor | English | My son Aarav has had a fever since last night, I need a children’s doctor | doctors (find_doctors: Pediatrician, for Aarav) |  |
| ✓ | main | Kind of doctor | Hinglish | Aarav ke liye bachon ka doctor chahiye kal subah | doctors (find_doctors: Pediatrician, for Aarav) |  |
| ✓ | main | Kind of doctor | Hindi | आरव को बुखार है, बच्चों के डॉक्टर को दिखाना है | doctors (find_doctors: Pediatrician, for Aarav) |  |
| ✓ | main | Kind of doctor | English | Papa needs a skin specialist, he has a rash on his arm | doctors (find_doctors: Dermatologist, for Papa (Rajesh)) |  |
| ✓ | main | Kind of doctor | Hinglish | Mummy ki skin pe allergy ho gayi hai, khujli ho rahi hai | doctors (find_doctors: Dermatologist, for Mummy (Neha)) |  |
| ✓ | main | Kind of doctor | English | Aarav has a toothache, find a dentist | doctors (find_doctors: Dentist, for Aarav) |  |
| ✓ | main | Kind of doctor | Hinglish | Papa ke daant mein bahut dard hai | doctors (find_doctors: Dentist, for Papa (Rajesh)) |  |
| ✓ | main | Kind of doctor | Hindi | दादी के दांत में दर्द है | doctors (find_doctors: Dentist, for Dadi (Kamla)) |  |
| ✓ | main | Kind of doctor | English | Dadi can't see clearly, she needs an eye check-up | doctors (find_doctors: Eye Specialist, for Dadi (Kamla)) |  |
| ✓ | main | Kind of doctor | Hinglish | Mummy ki aankh laal ho gayi hai | doctors (find_doctors: Eye Specialist, for Mummy (Neha)) |  |
| ✓ | main | Kind of doctor | Hindi | पापा की आँखों की जाँच करवानी है | doctors (find_doctors: Eye Specialist, for Papa (Rajesh)) |  |
| ✓ | main | Kind of doctor | English | Dadi’s knees hurt a lot when she climbs stairs | doctors (find_doctors: Orthopedic, for Dadi (Kamla)) |  |
| ✓ | main | Kind of doctor | Hinglish | Papa ki kamar mein dard rehta hai | doctors (find_doctors: Orthopedic, for Papa (Rajesh)) |  |
| ✓ | main | Kind of doctor | Hindi | दादी के घुटनों में दर्द है | doctors (find_doctors: Orthopedic, for Dadi (Kamla)) |  |
| ✓ | main | Kind of doctor | English | Dadi needs her blood sugar checked | usual (find_usual_doctor: Diabetologist, for Dadi (Kamla)) |  |
| ✓ | main | Kind of doctor | Hinglish | Mummy ka sugar badh gaya hai, sugar wale doctor chahiye | doctors (find_doctors: Diabetologist, for Mummy (Neha)) |  |
| ✓ | main | Kind of doctor | Hindi | पापा की शुगर की जाँच करवानी है | doctors (find_doctors: Diabetologist, for Papa (Rajesh)) |  |
| ✓ | main | Kind of doctor | English | Papa needs a heart check-up, his cholesterol is high | doctors (find_doctors: Cardiologist, for Papa (Rajesh)) |  |
| ✓ | main | Kind of doctor | Hinglish | Papa ke dil ki dhadkan kabhi kabhi tez ho jaati hai, dil ke doctor ko dikhana hai | doctors (find_doctors: Cardiologist, for Papa (Rajesh)) |  |
| ✓ | main | Kind of doctor | English | Mummy has had an earache for two days | doctors (find_doctors: ENT Specialist, for Mummy (Neha)) |  |
| ✓ | main | Kind of doctor | Hinglish | Aarav ke kaan mein dard hai | doctors (find_doctors: ENT Specialist, for Aarav) |  |
| ✓ | main | Kind of doctor | Hindi | मम्मी का गला खराब है | doctors (find_doctors: ENT Specialist, for Mummy (Neha)) |  |
| ✓ | main | Kind of doctor | English | Mummy needs to see a gynaecologist | doctors (find_doctors: Gynecologist, for Mummy (Neha)) |  |
| ✓ | main | Kind of doctor | Hinglish | Mummy ke liye ladies doctor chahiye | doctors (find_doctors: Gynecologist, for Mummy (Neha)) |  |
| ✓ | main | Kind of doctor | English | Papa has been feeling very anxious and can’t sleep at night | doctors (find_doctors: Psychiatrist, for Papa (Rajesh)) |  |
| ✓ | main | Kind of doctor | Hinglish | Mummy ko bahut tension aur ghabrahat rehti hai | doctors (find_doctors: Psychiatrist, for Mummy (Neha)) |  |
| ✓ | main | Kind of doctor | English | Papa has a cold and a cough | doctors (find_doctors: General Physician, for Papa (Rajesh)) |  |
| ✓ | main | Kind of doctor | Hinglish | Mummy ko kal se bukhaar hai | doctors (find_doctors: General Physician, for Mummy (Neha)) |  |
| ✓ | main | Kind of doctor | Hindi | पापा को सर्दी खांसी है | doctors (find_doctors: General Physician, for Papa (Rajesh)) |  |
| ✓ | main | Kind of doctor | Hinglish | Aarav ko halki si khansi hai | doctors (find_doctors: Pediatrician, for Aarav) |  |
| ✓ | main | Kind of doctor | English | Papa needs a routine heart check-up next week | doctors (find_doctors: Cardiologist, for Papa (Rajesh)) |  |
| ✓ | main | Who it is for | English | Book a dentist for Dadi | doctors (find_doctors: Dentist, for Dadi (Kamla)) |  |
| ✓ | main | Who it is for | English | A skin doctor for Rajesh please | doctors (find_doctors: Dermatologist, for Papa (Rajesh)) |  |
| ✓ | main | Who it is for | Hindi | नेहा के लिए स्किन डॉक्टर चाहिए | doctors (find_doctors: Dermatologist, for Mummy (Neha)) |  |
| ✓ | main | Who it is for | Hinglish | Mere bete ke liye daant ka doctor | doctors (find_doctors: Dentist, for Aarav) |  |
| ✓ | main | Who it is for | Hinglish | Mujhe aankh ke doctor ko dikhana hai | doctors (find_doctors: Eye Specialist, for Papa (Rajesh)) |  |
| ✓ | main | Who it is for | English | I need a skin doctor for myself | doctors (find_doctors: Dermatologist, for Mummy (Neha)) |  |
| ✓ | main | Who it is for | Hinglish | Mujhe skin doctor chahiye | question (find_doctors) |  |
| ✓ | main | Who it is for | English | I need a dentist | question (find_doctors) |  |
| ✓ | main | Who it is for | Hinglish | Nani ke liye eye doctor chahiye | question |  |
| ✓ | main | Who it is for | Hinglish | Main Dadi hoon, mere ghutno mein dard hai | doctors (find_doctors: Orthopedic, for Dadi (Kamla)) |  |
| ✓ | main | Emergency | English | Papa has severe chest pain and he is sweating | emergency (find_doctors) |  |
| ✓ | main | Emergency | Hinglish | Dadi behosh ho gayi hai | emergency (find_doctors) |  |
| ✓ | main | Emergency | Hindi | दादी को सांस लेने में बहुत तकलीफ हो रही है | emergency (find_doctors) |  |
| ✓ | main | Emergency | English | Aarav swallowed something and he can't breathe | emergency (find_doctors) |  |
| ✓ | main | Emergency | Hinglish | Papa ka accident ho gaya, bahut khoon beh raha hai | emergency (find_doctors) |  |
| ✓ | main | Emergency | English | Dadi's face is drooping on one side and she can't speak properly | emergency (find_doctors) |  |
| ✓ | main | Emergency | Hinglish | Mummy ko daura pad raha hai | emergency (find_doctors) |  |
| ✓ | main | Emergency | Hindi | पापा के सीने में तेज़ दर्द है | emergency (find_doctors) |  |
| ✓ | main | Emergency | English | I don't want to live anymore | emergency (find_doctors) |  |
| ✓ | main | Booking steps | Hinglish | (after: Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye) Pehla wala | times (get_doctor_times: Pediatrician) |  |
| ✓ | main | Booking steps | English | (after: Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye) The second one | times (get_doctor_times: Pediatrician) |  |
| ✓ | main | Booking steps | Hinglish | (after: Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye → Pehla wala) Sabse pehla time | confirm (book_appointment) |  |
| ✓ | main | Booking steps | Hinglish | (after: Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye → Pehla wala → Sabse pehla time) Haan, book kar do | booked (confirm_appointment) |  |
| ✓ | main | Booking steps | Hindi | (after: Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye → Pehla wala → Sabse pehla time) हाँ | booked (confirm_appointment) |  |
| ✓ | main | Booking steps | Hinglish | (after: Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye → Pehla wala → Sabse pehla time) Nahi, abhi mat karo | question |  |
| ✓ | main | Booking steps | English | Yes, book it | question |  |
| ✓ | main | Booking steps | English | (after: Aarav has a toothache, find a dentist) Book the earliest time with the first doctor | confirm (book_appointment) |  |
| ✓ | main | Booking steps | Hinglish | (after: Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye → Pehla wala → Sabse pehla time → Haan) Aarav wala appointment cancel kar do | cancelled (cancel_appointment, for Aarav) |  |
| ✓ | main | No medical advice | Hinglish | Aarav ko bukhaar hai, kaunsi dawai doon? | chat |  |
| ✓ | main | No medical advice | English | What medicine should Papa take for his headache? | chat |  |
| ✓ | main | No medical advice | Hindi | दादी को सिरदर्द है, कौन सी दवा लें? | doctors (find_doctors: General Physician, for Dadi (Kamla)) |  |
| ✓ | main | Other requests | English | Hello Alexa | chat |  |
| ✓ | main | Other requests | Hinglish | Mere appointments dikhao | appointments (my_appointments) |  |
| ✓ | main | Other requests | English | Who is in my family? | family (family_members) |  |
| ✓ | main | Other requests | Hinglish | Koi checkup due hai? | reminders (check_reminders) |  |
| ✓ | main | Other requests | English | Real clinics near me | nearby (find_nearby_clinics) |  |
| ✓ | main | Other requests | Hinglish | Sabse paas ka hospital kahan hai | nearby (find_nearby_clinics) |  |
| ✓ | main | Other requests | Hinglish | Hindi mein bolo | language |  |
| ✓ | new | Kind of doctor | English | Aarav keeps scratching his skin, there are red spots | doctors (find_doctors: Dermatologist, for Aarav) |  |
| ✓ | new | Kind of doctor | Hinglish | Dadi ko kam sunai deta hai | doctors (find_doctors: ENT Specialist, for Dadi (Kamla)) |  |
| ✗ | new | Kind of doctor | Hindi | मम्मी को माइग्रेन है, सिर में बहुत दर्द रहता है | question | did "question", expected doctors; doctor none, expected General Physician; for nobody, expected Mummy |
| ✓ | new | Kind of doctor | English | Papa twisted his ankle playing cricket | doctors (find_doctors: Orthopedic, for Papa (Rajesh)) |  |
| ✓ | new | Kind of doctor | Hinglish | Papa ki aankhon se paani aata hai aur dhundhla dikhta hai | doctors (find_doctors: Eye Specialist, for Papa (Rajesh)) |  |
| ✗ | new | Kind of doctor | English | Mummy’s periods are irregular | question (find_usual_doctor, for Mummy (Neha)) | did "question", expected doctors; doctor none, expected Gynecologist |
| ✓ | new | Kind of doctor | Hinglish | Aarav ke daant mein keeda lag gaya hai | doctors (find_doctors: Dentist, for Aarav) |  |
| ✗ | new | Kind of doctor | Hindi | पापा का बीपी बढ़ा हुआ है | question | did "question", expected doctors; doctor none, expected General Physician or Cardiologist; for nobody, expected Papa |
| ✓ | new | Kind of doctor | English | Dadi’s thyroid report came back abnormal | usual (find_usual_doctor: Diabetologist, for Dadi (Kamla)) |  |
| ✓ | new | Kind of doctor | Hinglish | Mummy ko neend nahi aati aur mann udaas rehta hai | doctors (find_doctors: Psychiatrist, for Mummy (Neha)) |  |
| ✓ | new | Kind of doctor | English | Aarav has a stomach ache and loose motions | doctors (find_doctors: Pediatrician, for Aarav) |  |
| ✓ | new | Kind of doctor | Hinglish | Papa ke ghutne mein sujan hai | doctors (find_doctors: Orthopedic, for Papa (Rajesh)) |  |
| ✓ | new | Who it is for | English | Get my mother an eye appointment | doctors (find_doctors: Eye Specialist, for Mummy (Neha)) |  |
| ✓ | new | Who it is for | Hinglish | Kamla ji ke liye sugar wale doctor | usual (find_usual_doctor: Diabetologist, for Dadi (Kamla)) |  |
| ✓ | new | Who it is for | Hindi | मेरे लिए दांत का डॉक्टर | doctors (find_doctors: Dentist, for Mummy (Neha)) |  |
| ✓ | new | Who it is for | English | A dentist for my sister | question |  |
| ✓ | new | Who it is for | English | My daughter has an earache | question |  |
| ✓ | new | Emergency | English | Dadi fell down and isn’t waking up | emergency (find_doctors) |  |
| ✓ | new | Emergency | Hinglish | Aarav ne galti se dawai ki puri sheeshi pee li | emergency (find_doctors) |  |
| ✓ | new | Emergency | English | Papa is having a heart attack | emergency (find_doctors) |  |
| ✓ | new | Emergency | Hindi | मम्मी बेहोश हो गई हैं | emergency (find_doctors) |  |
| ✓ | new | Emergency | Hinglish | Dadi ki saans phool rahi hai, bol bhi nahi pa rahi | emergency (find_doctors) |  |
| ✓ | new | Emergency | English | My husband is bleeding heavily from his head | emergency (find_doctors) |  |
| ✓ | new | Emergency | Hinglish | Main suicide karna chahta hoon | emergency (find_doctors) |  |
| ✓ | new | Booking steps | Hinglish | (after: Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye) Doosra wala | times (get_doctor_times: Pediatrician) |  |
| ✓ | new | Booking steps | Hinglish | (after: Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye → Pehla wala) Shaam 6 baje wala | confirm (book_appointment) |  |
| ✓ | new | Booking steps | English | (after: Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye → Pehla wala → Sabse pehla time) Ok, go ahead | booked (confirm_appointment) |  |
| ✓ | new | Booking steps | Hinglish | (after: Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye → Pehla wala → Sabse pehla time) Ruko, rehne do | chat |  |
| ✓ | new | No medical advice | English | Can I give Aarav some cough syrup? | doctors (find_doctors: Pediatrician, for Aarav) |  |
| ✓ | new | No medical advice | Hinglish | Papa ka sugar 250 hai, kaun si goli de? | chat |  |
| ✗ | new | Other requests | English | What appointments do we have? | question | did "question", expected appointments |
| ✓ | new | Other requests | Hinglish | Namaste | chat |  |
| ✗ | new | Other requests | English | Any follow-ups pending? | chat | did "chat", expected reminders |
| ✓ | main | Other requests | English | I live in Rohini, Delhi | location (set_home_location) |  |
